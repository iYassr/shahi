import { describe, expect, test } from "bun:test";
import { Auth, SESSION_COOKIE, readCookie } from "./auth";

const secret = "test-secret-not-used-anywhere-real";
const auth = (over: Partial<ConstructorParameters<typeof Auth>[0]> = {}) =>
  new Auth({ passcodeHash: "", sessionSecret: secret, sessionTtlMs: 60_000, ...over });

describe("passcode verification", () => {
  test("accepts the right passcode and rejects the wrong one", async () => {
    const hash = await Auth.hashPasscode("correct horse");
    const a = auth({ passcodeHash: hash });

    expect(a.disabled).toBe(false);
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

  test("an empty hash disables the gate", async () => {
    const a = auth();
    expect(a.disabled).toBe(true);
    expect(await a.verifyPasscode("anything at all")).toBe(true);
    expect(a.verifyToken(undefined)).toBe(true);
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
