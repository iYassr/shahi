import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { sha256 } from "@noble/hashes/sha2.js";
import { Auth } from "./auth";
import { Devices, PAIRING_TTL_MS, Pairing, pairingUrl } from "./pairing";

describe("pairing codes", () => {
  test("a minted code claims exactly once", () => {
    const pairing = new Pairing();
    const { secret } = pairing.mint(1_000);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url, unpadded
    expect(pairing.claim(secret, 2_000)).toBe(true);
    expect(pairing.claim(secret, 3_000)).toBe(false);
    expect(pairing.outstanding(3_000)).toBe(0);
  });

  test("two codes are never the same", () => {
    const pairing = new Pairing();
    expect(pairing.mint().secret).not.toBe(pairing.mint().secret);
  });

  // Over the relay a phone names its code by the hash of the secret bytes,
  // and the box must find the secret to derive the same key the phone will.
  test("an outstanding code is found by the hash of its bytes, until claimed or expired", () => {
    const pairing = new Pairing();
    const { secret } = pairing.mint(1_000);
    const bytes = new Uint8Array(Buffer.from(secret, "base64url"));
    const hash = Buffer.from(sha256(bytes)).toString("base64url");
    expect(pairing.secretByHash(hash, 2_000)).toEqual(bytes);
    // Looking is not claiming.
    expect(pairing.secretByHash(hash, 2_000)).toEqual(bytes);
    expect(pairing.secretByHash("nope", 2_000)).toBeNull();
    expect(pairing.claim(secret, 3_000)).toBe(true);
    expect(pairing.secretByHash(hash, 3_000)).toBeNull();

    const expiring = pairing.mint(0);
    const expiringHash = Buffer.from(sha256(Buffer.from(expiring.secret, "base64url"))).toString("base64url");
    expect(pairing.secretByHash(expiringHash, PAIRING_TTL_MS)).toBeNull();
  });

  test("a code nobody minted is refused", () => {
    expect(new Pairing().claim("nope")).toBe(false);
    expect(new Pairing().claim("")).toBe(false);
  });

  test("a code expires after ten minutes, and is gone rather than dormant", () => {
    const pairing = new Pairing();
    const { secret, expiresAt } = pairing.mint(0);
    expect(expiresAt).toBe(PAIRING_TTL_MS);
    expect(pairing.claim(secret, PAIRING_TTL_MS)).toBe(false);
    // An expired code that was never claimed must not linger in memory either.
    pairing.mint(PAIRING_TTL_MS + 1);
    expect(pairing.outstanding(PAIRING_TTL_MS + 1)).toBe(1);
  });

  // The secret rides in the fragment so it never reaches a web server if the
  // code is opened as a link; the phone parses this exact shape.
  test("the QR text is a shahi://pair fragment with every field encoded", () => {
    const url = pairingUrl({
      v: 1,
      server: "0c5e1b9c-6d4d-4a0f-9d5e-9f4a2b1c3d7e",
      relay: "https://relay.example.workers.dev",
      secret: "a_b-c",
    });
    expect(url.startsWith("shahi://pair#")).toBe(true);
    expect(url).not.toContain("?");
    const params = new URLSearchParams(url.slice("shahi://pair#".length));
    expect(params.get("v")).toBe("1");
    expect(params.get("server")).toBe("0c5e1b9c-6d4d-4a0f-9d5e-9f4a2b1c3d7e");
    expect(params.get("relay")).toBe("https://relay.example.workers.dev");
    expect(params.get("secret")).toBe("a_b-c");
    // The address a phone once typed is gone from the format: a code is a
    // relay code, and a box without one mints nothing.
    expect(params.has("endpoint")).toBe(false);
  });
});

describe("devices", () => {
  const fresh = () => new Devices(new Database(":memory:"));

  test("a created device is listed, active, and named after the phone", () => {
    const devices = fresh();
    const { device } = devices.create("  Yasser's iPhone  ", 5_000);
    expect(device.name).toBe("Yasser's iPhone");
    expect(device.createdAt).toBe(5_000);
    expect(devices.list()).toEqual([device]);
    expect(devices.isActive(device.id)).toBe(true);
  });

  test("a blank name becomes something, and a long one is cut", () => {
    const devices = fresh();
    expect(devices.create("   ").device.name).toBe("Phone");
    expect(devices.create("x".repeat(200)).device.name).toHaveLength(64);
  });

  // The secret is the phone's half of the relay key: handed over once, never
  // listed, and gone from the box's answers the moment the device is revoked.
  test("each device gets its own 32-byte secret, readable while it is active and never listed", () => {
    const devices = fresh();
    const a = devices.create("a");
    const b = devices.create("b");
    expect(a.secret).toHaveLength(32);
    expect(a.secret).not.toEqual(b.secret);
    expect(devices.secret(a.device.id)).toEqual(a.secret);
    expect(devices.secret("never-existed")).toBeNull();
    expect(JSON.stringify(devices.list())).not.toContain(Buffer.from(a.secret).toString("base64url"));
    devices.revoke(a.device.id);
    expect(devices.secret(a.device.id)).toBeNull();
    expect(devices.secret(b.device.id)).toEqual(b.secret);
  });

  test("revoking removes a device from the list and from the gate, once", () => {
    const devices = fresh();
    const keep = devices.create("keep", 1).device;
    const gone = devices.create("gone", 2).device;
    expect(devices.revoke(gone.id)).toBe(true);
    expect(devices.revoke(gone.id)).toBe(false);
    expect(devices.revoke("never-existed")).toBe(false);
    expect(devices.isActive(gone.id)).toBe(false);
    expect(devices.list().map((d) => d.id)).toEqual([keep.id]);
  });

  // The phone polls forever; a write per poll would be a write per poll. Once
  // a minute is as fresh as "last seen" needs to be.
  test("last seen moves at most once a minute", () => {
    const devices = fresh();
    const { device } = devices.create("p", 0);
    devices.touch(device.id, 30_000);
    expect(devices.list()[0]!.lastSeenAt).toBe(0);
    devices.touch(device.id, 60_000);
    expect(devices.list()[0]!.lastSeenAt).toBe(60_000);
    devices.touch(device.id, 61_000);
    expect(devices.list()[0]!.lastSeenAt).toBe(60_000);
  });
});

describe("a session bound to a device", () => {
  const secret = "test-secret-not-used-anywhere-real";
  const gated = "$2b$12$placeholderplaceholderplaceholderplaceholderplaceh";

  test("the token carries the device id, and a passcode token carries none", () => {
    const auth = new Auth({ passcodeHash: gated, sessionSecret: secret, sessionTtlMs: 60_000 });
    expect(auth.identify(auth.issue(0, "dev-1"), 1)).toEqual({ deviceId: "dev-1" });
    expect(auth.identify(auth.issue(0), 1)).toEqual({ deviceId: null });
    expect(auth.identify(auth.issue(0, "dev-1"), 60_000)).toBeNull(); // expired
  });

  test("the device id is inside the signature, so it cannot be swapped", () => {
    const auth = new Auth({ passcodeHash: gated, sessionSecret: secret, sessionTtlMs: 60_000 });
    const token = auth.issue(0, "dev-1");
    const signature = token.slice(token.lastIndexOf(".") + 1);
    const expiry = token.slice(0, token.indexOf("."));
    expect(auth.verifyToken(`${expiry}.dev-2.${signature}`, 1)).toBe(false);
    expect(auth.verifyToken(`${expiry}.${signature}`, 1)).toBe(false);
  });

  // The point of devices over passcodes: revoking one takes effect on its next
  // request, with the cookie still weeks from expiry.
  test("revoking the device rejects its token on the next check", () => {
    const devices = new Devices(new Database(":memory:"));
    const auth = new Auth({
      passcodeHash: gated,
      sessionSecret: secret,
      sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
      deviceActive: (id) => devices.isActive(id),
    });
    const { device } = devices.create("phone");
    const token = auth.issue(Date.now(), device.id);
    expect(auth.verifyToken(token)).toBe(true);
    devices.revoke(device.id);
    expect(auth.verifyToken(token)).toBe(false);
    expect(auth.identify(token)).toBeNull();
  });

  test("with the gate off a revoked device is still let in, anonymously", () => {
    const auth = new Auth({
      passcodeHash: "",
      sessionSecret: secret,
      sessionTtlMs: 60_000,
      deviceActive: () => false,
    });
    expect(auth.identify(auth.issue(0, "dev-1"), 1)).toEqual({ deviceId: null });
  });
});
