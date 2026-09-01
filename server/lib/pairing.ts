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

  mint(now = Date.now()): PairingCode {
    this.#prune(now);
    const secret = randomBytes(32).toString("base64url");
    const expiresAt = now + PAIRING_TTL_MS;
    this.#codes.set(secret, expiresAt);
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
    this.#codes.delete(secret);
    return expiresAt > now;
  }

  /** Codes minted and neither claimed nor expired. */
  outstanding(now = Date.now()): number {
    this.#prune(now);
    return this.#codes.size;
  }

  #prune(now = Date.now()): void {
    for (const [secret, expiresAt] of this.#codes) {
      if (expiresAt <= now) this.#codes.delete(secret);
    }
  }
}

/** The text the QR encodes. See `PairingPayload` for why it is a fragment. */
export function pairingUrl(payload: PairingPayload): string {
  const params = new URLSearchParams({
    v: String(payload.v),
    server: payload.server,
    endpoint: payload.endpoint,
    secret: payload.secret,
  });
  return `shahi://pair#${params.toString()}`;
}

/**
 * Phones that paired, in SQLite.
 *
 * A revoked row is kept, not deleted: `revoked_at` is the record of when a
 * phone lost access, and a token minted for that id must keep failing rather
 * than start matching nothing.
 */
export class Devices {
  constructor(private readonly db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        revoked_at   INTEGER
      )
    `);
  }

  create(name: string, now = Date.now()): PairedDevice {
    const cleaned = name.trim().slice(0, DEVICE_NAME_MAX) || "Phone";
    const device: PairedDevice = { id: randomUUID(), name: cleaned, createdAt: now, lastSeenAt: now };
    this.db
      .query("INSERT INTO devices (id, name, created_at, last_seen_at) VALUES (?, ?, ?, ?)")
      .run(device.id, device.name, device.createdAt, device.lastSeenAt);
    return device;
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
