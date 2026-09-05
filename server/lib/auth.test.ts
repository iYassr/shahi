import { describe, expect, test } from "bun:test";
import { Auth, LoginThrottle, SESSION_COOKIE, readCookie } from "./auth";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const secret = "test-secret-not-used-anywhere-real";
const auth = (over: Partial<ConstructorParameters<typeof Auth>[0]> = {}) =>
  new Auth({ passcodeHash: "", sessionSecret: secret, sessionTtlMs: 60_000, ...over });

describe("passcode verification", () => {
  test("accepts the right passcode and rejects the wrong one", async () => {
    const hash = await Auth.hashPasscode("correct horse");
    const a = auth({ passcodeHash: hash });

    expect(await a.verifyPasscode("correct horse")).toBe(true);
    expect(await a.verifyPasscode("wrong")).toBe(false);
    expect(await a.verifyPasscode("")).toBe(false);
  });

  test("hashes are salted, so the same passcode hashes differently", async () => {
    const [a, b] = await Promise.all([Auth.hashPasscode("same"), Auth.hashPasscode("same")]);
    expect(a).not.toBe(b);
  });

  // A truncated or hand-edited .env must fail closed, not open.
  test("a malformed hash rejects every passcode", async () => {
    const a = auth({ passcodeHash: "not-a-bcrypt-hash" });
    expect(await a.verifyPasscode("anything")).toBe(false);
  });

  test("an empty hash never opens the gate", async () => {
    const a = auth();
    expect(await a.verifyPasscode("anything at all")).toBe(false);
    expect(a.verifyToken(undefined)).toBe(false);
    expect(a.verifyToken("forged")).toBe(false);
  });
});

describe("session tokens", () => {
  const a = auth({ passcodeHash: "$2b$12$placeholderplaceholderplaceholderplaceholderplaceh" });

  test("accepts a freshly issued token", () => {
    expect(a.verifyToken(a.issue())).toBe(true);
  });

  test("rejects a missing or empty token", () => {
    expect(a.verifyToken(undefined)).toBe(false);
    expect(a.verifyToken("")).toBe(false);
  });

  test("rejects an expired token", () => {
    const now = Date.now();
    const token = a.issue(now - 120_000); // TTL is 60s
    expect(a.verifyToken(token, now)).toBe(false);
  });

  // The expiry is only trustworthy because the signature covers it; extending
  // it by hand must not work.
  test("rejects a token whose expiry was tampered with", () => {
    const token = a.issue();
    const signature = token.slice(token.lastIndexOf(".") + 1);
    const forged = `${Date.now() + 10_000_000}.${signature}`;
    expect(a.verifyToken(forged)).toBe(false);
  });

  test("rejects a token signed with a different secret", () => {
    const other = new Auth({
      passcodeHash: "x",
      sessionSecret: "a different secret",
      sessionTtlMs: 60_000,
    });
    expect(a.verifyToken(other.issue())).toBe(false);
  });

  test("rejects malformed tokens", () => {
    for (const bad of ["nodot", ".", ".sig", "abc.", "...."]) {
      expect(a.verifyToken(bad)).toBe(false);
    }
  });
});

describe("cookies", () => {
  test("HTTPS session and deletion cookies carry Secure", () => {
    expect(auth().cookie("token", true)).toContain("; Secure");
    expect(Auth.clearCookie(true)).toContain("; Secure");
    expect(auth().cookie("token", false)).not.toContain("Secure");
  });
  test("marks the session cookie HttpOnly and SameSite", () => {
    const cookie = auth().cookie("token-value");
    expect(cookie).toContain(`${SESSION_COOKIE}=token-value`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Max-Age=60");
  });

  test("clearing expires the cookie immediately", () => {
    expect(Auth.clearCookie()).toContain("Max-Age=0");
  });

  test("reads one cookie out of a header", () => {
    const header = `other=1; ${SESSION_COOKIE}=abc.def; another=2`;
    expect(readCookie(header, SESSION_COOKIE)).toBe("abc.def");
    expect(readCookie(header, "other")).toBe("1");
    expect(readCookie(header, "missing")).toBeUndefined();
    expect(readCookie(null, SESSION_COOKIE)).toBeUndefined();
  });

  test("is not fooled by a cookie name that is a suffix of another", () => {
    expect(readCookie(`not_${SESSION_COOKIE}=nope`, SESSION_COOKIE)).toBeUndefined();
  });
});

test("logout survives a database reopen and leaves independent simultaneous logins valid", () => {
  const dir = mkdtempSync(join(tmpdir(), "shahi-session-revoke-"));
  const path = join(dir, "test.sqlite");
  const options = { passcodeHash: "configured", sessionSecret: secret, sessionTtlMs: 60_000 };
  let db = new Database(path);
  try {
    const first = new Auth(options, db);
    const now = Date.now();
    const stolen = first.issue(now);
    const other = first.issue(now);
    expect(stolen).not.toBe(other);
    expect(first.revoke("forged")).toBe(false);
    expect(first.revoke(stolen, now)).toBe(true);
    expect(first.verifyToken(stolen, now)).toBe(false);
    expect(first.verifyToken(other, now)).toBe(true);
    db.close();
    db = new Database(path);
    const restarted = new Auth(options, db);
    expect(restarted.verifyToken(stolen, now)).toBe(false);
    expect(restarted.verifyToken(other, now)).toBe(true);
    // Expired revocations are pruned when a later logout is recorded.
    const later = restarted.issue(now + 60_001);
    restarted.revoke(later, now + 60_001);
    expect(db.query("SELECT COUNT(*) AS n FROM revoked_sessions").get()).toEqual({ n: 1 });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

describe("LoginThrottle", () => {
  // A fake clock and sleep so the test asserts the backoff schedule without
  // real waits: `sleep` records the delay and advances the clock.
  const harness = () => {
    let clock = 0;
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
      clock += ms;
    };
    return { waits, sleep, now: () => clock };
  };

  test("does not delay the first attempt or a success", async () => {
    const { waits, sleep, now } = harness();
    const t = new LoginThrottle();
    expect(await t.attempt(async () => true, sleep, now)).toBe(true);
    expect(waits).toEqual([]);
  });

  test("delays grow after each failure and reset on success", async () => {
    const { waits, sleep, now } = harness();
    const t = new LoginThrottle();
    await t.attempt(async () => false, sleep, now); // 1st fail: no pre-wait
    await t.attempt(async () => false, sleep, now); // waits 500 (from 1 failure)
    await t.attempt(async () => false, sleep, now); // waits 1000
    await t.attempt(async () => true, sleep, now); //  waits 2000, then resets
    expect(waits).toEqual([500, 1000, 2000]);
    // After a success the counter is clear, so the next failure starts over.
    await t.attempt(async () => false, sleep, now);
    await t.attempt(async () => false, sleep, now);
    expect(waits).toEqual([500, 1000, 2000, 500]);
  });

  test("serialises concurrent attempts so none skips the wait", async () => {
    const { waits, sleep, now } = harness();
    const t = new LoginThrottle();
    // Fire three failing attempts at once; they must run one after another,
    // each seeing the previous one's backoff rather than all racing through.
    await Promise.all([
      t.attempt(async () => false, sleep, now),
      t.attempt(async () => false, sleep, now),
      t.attempt(async () => false, sleep, now),
    ]);
    expect(waits).toEqual([500, 1000]);
  });
});
