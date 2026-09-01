import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ed25519 } from "@noble/curves/ed25519.js";
import { BOX_AUTH_PREFIX } from "@shahi/shared";
import { fromSeed, serverIdFor, serverIdentity } from "./identity";

describe("the box identity", () => {
  test("is minted once and read back the same from the same database", () => {
    const db = new Database(":memory:");
    const first = serverIdentity(db);
    const again = serverIdentity(db);
    expect(again.serverId).toBe(first.serverId);
    expect(again.publicKey).toEqual(first.publicKey);
    expect(serverIdentity(new Database(":memory:")).serverId).not.toBe(first.serverId);
  });

  test("the id is base64url(sha256(publicKey)), 43 characters", () => {
    const identity = serverIdentity(new Database(":memory:"));
    expect(identity.serverId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(identity.serverId).toBe(serverIdFor(identity.publicKey));
  });

  // What the relay checks: the signature over prefix+id+nonce verifies under
  // the public key whose hash is the id. A second box cannot answer for the first.
  test("signs the relay challenge so only the holder of the seed can answer", () => {
    const box = serverIdentity(new Database(":memory:"));
    const other = fromSeed(crypto.getRandomValues(new Uint8Array(32)));
    const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const message = new TextEncoder().encode(BOX_AUTH_PREFIX + box.serverId + nonce);
    const sig = box.sign(message);
    expect(sig).toHaveLength(64);
    expect(ed25519.verify(sig, message, box.publicKey)).toBe(true);
    expect(ed25519.verify(other.sign(message), message, box.publicKey)).toBe(false);
  });

  test("a seed that is not 32 bytes is refused rather than silently truncated", () => {
    expect(() => fromSeed(new Uint8Array(16))).toThrow(/32 bytes/);
  });
});
