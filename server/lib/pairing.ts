/**
 * Pairing: how a phone is introduced to a server without typing anything.
 *
 * The server mints a code — 32 random bytes, one use, ten minutes — and a
 * script prints it as a QR. The phone scans it, checks it is talking to the
 * server the code names, and claims it. The claim answers with a session
 * cookie bound to a new **device**, which is the thing the passcode never had:
 * an identity that can be listed in Settings and revoked, taking effect on the
 * revoked phone's very next request.
 *
 * Codes live in memory on purpose. A restart voids every outstanding code and
 * costs nothing — whoever was mid-pairing runs the script again — while a
 * table of secrets on disk would be one more place a secret could be read
 * from. Devices are the opposite: they must outlive restarts, so they sit in
 * the same SQLite file as everything else.
 */
import type { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import type { PairedDevice, PairingCode, PairingPayload } from "@shahi/shared";

export const PAIRING_TTL_MS = 10 * 60 * 1000;

/** Longer than any phone name in practice; shorter than a paste of something else. */
const DEVICE_NAME_MAX = 64;

/**
 * How often `last_seen_at` is allowed to change. The phone polls every few
 * seconds forever; writing a row per request would turn "last seen" into a
 * write per poll for no more information than "recently".
 */
const LAST_SEEN_GRANULARITY_MS = 60_000;

export class Pairing {
  /** secret → expiresAt */
  readonly #codes = new Map<string, number>();
  /**
   * base64url(sha256(secret bytes)) → secret. A phone reaching the box over
   * the relay names its code by this hash, never by the secret itself, which
   * it must keep for the key derivation (`docs/relay.md`).
   */
  readonly #byHash = new Map<string, string>();

  mint(now = Date.now()): PairingCode {
    this.#prune(now);
    const bytes = randomBytes(32);
    const secret = bytes.toString("base64url");
    const expiresAt = now + PAIRING_TTL_MS;
    this.#codes.set(secret, expiresAt);
    this.#byHash.set(hashOf(bytes), secret);
    return { secret, expiresAt };
  }

  /**
   * Consumes a code. True once, then never again — an expired or unknown
   * secret is simply false, so a caller cannot tell the two apart and neither
   * can anyone guessing. The lookup is a map read on a 256-bit secret behind
   * the login throttle; it is not where a timing attack lives.
   */
  claim(secret: string, now = Date.now()): boolean {
    this.#prune(now);
    const expiresAt = this.#codes.get(secret);
    if (expiresAt === undefined) return false;
    this.#forget(secret);
    return expiresAt > now;
  }

  /**
   * The bytes of an outstanding code, found by their hash — what a pairing
   * link's hello carries. Looking is not claiming: the code stays until the
   * phone posts it to `/api/pair/claim` over the link it opened with it.
   */
  secretByHash(hash: string, now = Date.now()): Uint8Array | null {
    this.#prune(now);
    const secret = this.#byHash.get(hash);
    return secret === undefined ? null : new Uint8Array(Buffer.from(secret, "base64url"));
  }

  /** Codes minted and neither claimed nor expired. */
  outstanding(now = Date.now()): number {
    this.#prune(now);
    return this.#codes.size;
  }

  #prune(now = Date.now()): void {
    for (const [secret, expiresAt] of this.#codes) {
      if (expiresAt <= now) this.#forget(secret);
    }
  }

  #forget(secret: string): void {
    this.#codes.delete(secret);
    this.#byHash.delete(hashOf(Buffer.from(secret, "base64url")));
  }
}

function hashOf(secretBytes: Uint8Array): string {
  return Buffer.from(sha256(secretBytes)).toString("base64url");
}

/** The text the QR encodes. See `PairingPayload` for why it is a fragment. */
export function pairingUrl(payload: PairingPayload): string {
  const params = new URLSearchParams({
    v: String(payload.v),
    server: payload.server,
    endpoint: payload.endpoint,
    // Only when the box has one: an absent key is what "no relay" looks like
    // to the phone, not an empty string it would have to special-case.
    ...(payload.relay ? { relay: payload.relay } : {}),
    secret: payload.secret,
  });
  return `shahi://pair#${params.toString()}`;
}

/** What a claim hands the phone: the device, and its share of the relay key. */
export interface CreatedDevice {
  device: PairedDevice;
  /** 32 bytes. Sent once, at pairing; the phone keeps it in the Keychain. */
  secret: Uint8Array;
}

/**
 * Phones that paired, in SQLite.
 *
 * A revoked row is kept, not deleted: `revoked_at` is the record of when a
 * phone lost access, and a token minted for that id must keep failing rather
 * than start matching nothing.
 *
 * Each device also has a **secret**: 32 bytes minted at pairing and shared
 * with that phone alone, the long-lived half of the end-to-end key when the
 * phone comes in through the relay (`docs/relay.md`). Stored raw — this
 * process already holds `SESSION_SECRET` in the clear, and a hash would be
 * useless here because the secret is an input to a key derivation, not
 * something to compare.
 */
export class Devices {
  constructor(private readonly db: Database) {
    // A table from before devices had secrets cannot hold a device that works:
    // the secret is the relay session's long-lived key. There is no migration
    // here by rule (CLAUDE.md) — those rows are simply gone and their phones
    // pair again, which is what an upgrade already means for a serverId. The
    // first box to upgrade in place answered every claim with "table devices
    // has no column named secret" and the phone saw only a dropped link.
    const columns = db.query<{ name: string }, []>("PRAGMA table_info(devices)").all();
    if (columns.length > 0 && !columns.some((c) => c.name === "secret")) db.exec("DROP TABLE devices");
    db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        secret       BLOB NOT NULL,
        created_at   INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        revoked_at   INTEGER
      )
    `);
  }

  create(name: string, now = Date.now()): CreatedDevice {
    const cleaned = name.trim().slice(0, DEVICE_NAME_MAX) || "Phone";
    const device: PairedDevice = { id: randomUUID(), name: cleaned, createdAt: now, lastSeenAt: now };
    const secret = new Uint8Array(randomBytes(32));
    this.db
      .query("INSERT INTO devices (id, name, secret, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)")
      .run(device.id, device.name, secret, device.createdAt, device.lastSeenAt);
    return { device, secret };
  }

  /** The relay key share of a device that can still act; null once revoked or never known. */
  secret(id: string): Uint8Array | null {
    const row = this.db
      .query<{ secret: Uint8Array }, [string]>("SELECT secret FROM devices WHERE id = ? AND revoked_at IS NULL")
      .get(id);
    return row ? new Uint8Array(row.secret) : null;
  }

  /** Devices that can still act, oldest first. */
  list(): PairedDevice[] {
    return this.db
      .query<Row, []>(
        "SELECT id, name, created_at, last_seen_at FROM devices WHERE revoked_at IS NULL ORDER BY created_at, id",
      )
      .all()
      .map(fromRow);
  }

  /** Consulted on every request: the reason revocation is immediate. */
  isActive(id: string): boolean {
    return (
      this.db.query<{ n: number }, [string]>("SELECT 1 AS n FROM devices WHERE id = ? AND revoked_at IS NULL").get(id) !==
      null
    );
  }

  /** Notes that the device was just heard from, at most once a minute. */
  touch(id: string, now = Date.now()): void {
    this.db
      .query("UPDATE devices SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL AND last_seen_at <= ?")
      .run(now, id, now - LAST_SEEN_GRANULARITY_MS);
  }

  /** True if the device existed and was not already revoked. */
  revoke(id: string, now = Date.now()): boolean {
    const result = this.db.query("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, id);
    return result.changes > 0;
  }
}

interface Row {
  id: string;
  name: string;
  created_at: number;
  last_seen_at: number;
}

const fromRow = (row: Row): PairedDevice => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
});
