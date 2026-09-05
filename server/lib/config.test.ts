import { describe, expect, test } from "bun:test";
import { Auth } from "./auth";
import { loadConfig } from "./config";

const base = { SESSION_SECRET: "s".repeat(32), PASSCODE_HASH_B64: Buffer.from(await Auth.hashPasscode("config-test")).toString("base64") } as NodeJS.ProcessEnv;

describe("loadConfig", () => {
  test("requires a session secret", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/SESSION_SECRET is not set/);
  });

  test("binds loopback unless told otherwise", () => {
    // The default has to be the safe one: this process proxies every herdr
    // method, and herdr's own socket has no authentication.
    expect(loadConfig(base).host).toBe("127.0.0.1");
  });

  test("refuses network binds even when a passcode is present", () => {
    for (const HOST of ["0.0.0.0", "::", "100.100.100.100", "192.168.1.2", "example.com"]) {
      expect(() => loadConfig({ ...base, HOST })).toThrow(/loopback/);
    }
  });

  test("defaults the port to 7171", () => {
    expect(loadConfig(base).port).toBe(7171);
    expect(loadConfig({ ...base, PORT: "9000" }).port).toBe(9000);
  });

  test("has no relay unless RELAY_URL names one, and refuses one that is not an http(s) URL", () => {
    expect(loadConfig(base).relayUrl).toBeNull();
    expect(loadConfig({ ...base, RELAY_URL: "" }).relayUrl).toBeNull();
    expect(loadConfig({ ...base, RELAY_URL: "https://relay.example.workers.dev/" }).relayUrl).toBe(
      "https://relay.example.workers.dev",
    );
    expect(() => loadConfig({ ...base, RELAY_URL: "relay.example.workers.dev" })).toThrow(/RELAY_URL/);
    expect(() => loadConfig({ ...base, RELAY_URL: "wss://relay.example.workers.dev" })).toThrow(/http\(s\)/);
  });

  test("refuses missing and empty passcodes instead of opening the gate", () => {
    expect(() => loadConfig({ SESSION_SECRET: base.SESSION_SECRET })).toThrow(/PASSCODE_HASH_B64 is required/);
    expect(() => loadConfig({ ...base, PASSCODE_HASH_B64: "" })).toThrow(/PASSCODE_HASH_B64 is required/);
  });

  test("refuses plaintext and credential-bearing relays except local test origins", () => {
    for (const RELAY_URL of ["http://relay.example", "https://user:password@relay.example", "https://relay.example/path", "https://relay.example/?key=secret", "https://relay.example/#secret"]) {
      expect(() => loadConfig({ ...base, RELAY_URL })).toThrow(/RELAY_URL/);
    }
    expect(loadConfig({ ...base, RELAY_URL: "http://127.0.0.1:8787" }).relayUrl).toBe("http://127.0.0.1:8787");
  });

  describe("passcode hash decoding", () => {
    // Regression. A bcrypt hash is full of `$`, and Bun's dotenv loader performs
    // shell-style variable expansion on values — inside quotes too — so a raw
    // `$2b$12$...` loads as a mangled fragment. It then rejects every passcode,
    // which is indistinguishable from simply typing the wrong one.
    test("round-trips a real bcrypt hash through base64", async () => {
      const hash = await Auth.hashPasscode("4821");
      const encoded = Buffer.from(hash, "utf8").toString("base64");

      const config = loadConfig({ ...base, PASSCODE_HASH_B64: encoded });
      expect(config.passcodeHash).toBe(hash);

      // And the decoded hash must actually verify.
      const auth = new Auth({
        passcodeHash: config.passcodeHash,
        sessionSecret: config.sessionSecret,
        sessionTtlMs: 1000,
      });
      expect(await auth.verifyPasscode("4821")).toBe(true);
      expect(await auth.verifyPasscode("0000")).toBe(false);
    });

    test("base64 of a bcrypt hash contains no dollar sign to be expanded", async () => {
      const encoded = Buffer.from(await Auth.hashPasscode("4821"), "utf8").toString("base64");
      expect(encoded).not.toContain("$");
    });

    // Failing loudly at startup beats rejecting the right passcode forever.
    test("rejects a raw bcrypt hash pasted in unencoded", async () => {
      const raw = await Auth.hashPasscode("4821");
      expect(() => loadConfig({ ...base, PASSCODE_HASH_B64: raw })).toThrow(/did not decode/);
    });

    test("rejects a hash mangled by dotenv expansion", () => {
      // What `$2b$12$abc...` actually becomes once `$2b` and `$12` expand away.
      const mangled = Buffer.from(".030UBLj4aXol//uU1NRHuV9m/0OYyBO", "utf8").toString("base64");
      expect(() => loadConfig({ ...base, PASSCODE_HASH_B64: mangled })).toThrow(/did not decode/);
    });

    test("rejects arbitrary base64 that is not a bcrypt hash", () => {
      const junk = Buffer.from("hunter2", "utf8").toString("base64");
      expect(() => loadConfig({ ...base, PASSCODE_HASH_B64: junk })).toThrow(/did not decode/);
    });
  });

  test("enables push only when both VAPID keys are present", () => {
    expect(loadConfig(base).vapid).toBeNull();
    expect(loadConfig({ ...base, VAPID_PUBLIC_KEY: "pub" }).vapid).toBeNull();

    const config = loadConfig({ ...base, VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv" });
    expect(config.vapid).toEqual({
      publicKey: "pub",
      privateKey: "priv",
      subject: "mailto:shahi@localhost",
    });
  });
});
