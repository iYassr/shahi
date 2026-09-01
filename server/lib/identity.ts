/**
 * Who this server is, across restarts — and how it proves it.
 *
 * The phone holds credentials that should survive the server's address
 * changing (a tunnel restarted, a tailnet renamed), so they bind to something
 * stabler than a URL. That used to be a random UUID. The blind relay
 * (`docs/relay.md`) needs more: a box must be able to *prove* it owns its id,
 * or anyone could sit on the relay under someone else's id and collect their
 * phones' hellos. So the id is now derived from an Ed25519 public key —
 * `base64url(sha256(publicKey))` — and the relay challenges the box to sign a
 * nonce. Nothing holding only the id can answer.
 *
 * The seed is kept in the same `meta` table as everything else, base64url.
 * There is no path from the old UUID: a box that upgrades gets a new id and
 * its phones pair again (CLAUDE.md: no compatibility layers).
 */
import type { Database } from "bun:sqlite";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";

export interface ServerIdentity {
  /** `base64url(sha256(publicKey))`: 43 characters, unguessable, unclaimable without the seed. */
  serverId: string;
  /** Ed25519, 32 bytes. Sent to the relay with every signature so it can check it against the id. */
  publicKey: Uint8Array;
  /** An Ed25519 signature over `bytes`, 64 bytes. */
  sign(bytes: Uint8Array): Uint8Array;
}

const SEED_KEY = "identity_seed";

export function serverIdentity(db: Database): ServerIdentity {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const row = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(SEED_KEY);
  let seed: Uint8Array;
  if (row) {
    seed = new Uint8Array(Buffer.from(row.value, "base64url"));
  } else {
    seed = crypto.getRandomValues(new Uint8Array(32));
    db.query("INSERT INTO meta (key, value) VALUES (?, ?)").run(SEED_KEY, Buffer.from(seed).toString("base64url"));
  }
  return fromSeed(seed);
}

/** The identity a 32-byte seed names. Exported so a test can hold a second box without a database. */
export function fromSeed(seed: Uint8Array): ServerIdentity {
  if (seed.length !== 32) throw new Error("identity: the seed is not 32 bytes");
  const publicKey = ed25519.getPublicKey(seed);
  return {
    serverId: serverIdFor(publicKey),
    publicKey,
    sign: (bytes) => ed25519.sign(bytes, seed),
  };
}

/** How the id follows from the key — the relay computes the same thing to check a box's `auth`. */
export function serverIdFor(publicKey: Uint8Array): string {
  return Buffer.from(sha256(publicKey)).toString("base64url");
}
