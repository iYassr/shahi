/**
 * Signed, independently revocable sessions. Revoked token digests live in the
 * sidecar database so logout survives a restart. Offline owner scripts can
 * still sign short-lived tokens without registering them with the server.
 */
import { password as bunPassword } from "bun";
import { Database } from "bun:sqlite";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "shahi_session";

export interface AuthOptions {
  passcodeHash: string;
  sessionSecret: string;
  sessionTtlMs: number;
  deviceActive?: (deviceId: string) => boolean;
}

export interface Identity { deviceId: string | null; }

export class Auth {
  // The default is for isolated tests and token-signing scripts. The running
  // server supplies its persistent database, shared with devices/transcripts.
  constructor(private readonly options: AuthOptions, private readonly db = new Database(":memory:")) {
    db.exec("CREATE TABLE IF NOT EXISTS revoked_sessions (digest TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)");
    this.#prune(Date.now());
  }

  static async hashPasscode(passcode: string): Promise<string> {
    return bunPassword.hash(passcode, { algorithm: "bcrypt", cost: 12 });
  }

  async verifyPasscode(passcode: string): Promise<boolean> {
    if (!this.options.passcodeHash) return false;
    try { return await bunPassword.verify(passcode, this.options.passcodeHash); }
    catch { return false; }
  }

  issue(now = Date.now(), deviceId: string | null = null): string {
    // Distinct sessions must remain independently revocable even when two
    // logins happen in the same millisecond.
    if (deviceId !== null && !/^[A-Za-z0-9_-]+$/.test(deviceId)) throw new Error("invalid device id");
    const claims = `${now + this.options.sessionTtlMs}.${deviceId ?? ""}.${randomUUID()}`;
    return `${claims}.${this.#sign(claims)}`;
  }

  verifyToken(token: string | undefined, now = Date.now()): boolean {
    return this.identify(token, now) !== null;
  }

  identify(token: string | undefined, now = Date.now()): Identity | null {
    if (!token || token.length > 512) return null;
    const parts = token.split(".");
    if (parts.length !== 4) return null;
    const [expiry, device, nonce, signature] = parts as [string, string, string, string];
    if (!/^\d+$/.test(expiry) || !/^[A-Za-z0-9_-]*$/.test(device) || !/^[a-f0-9-]{36}$/.test(nonce)) return null;
    const claims = `${expiry}.${device}.${nonce}`;
    if (!this.#signatureMatches(claims, signature)) return null;
    const expiresAt = Number(expiry);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return null;
    if (this.db.query("SELECT 1 FROM revoked_sessions WHERE digest = ?").get(this.#digest(token))) return null;
    const deviceId = device || null;
    if (deviceId !== null && !(this.options.deviceActive?.(deviceId) ?? true)) return null;
    return { deviceId };
  }

  revoke(token: string | undefined, now = Date.now()): boolean {
    if (!token || !this.identify(token, now)) return false;
    this.#prune(now);
    this.db.query("INSERT OR IGNORE INTO revoked_sessions (digest, expires_at) VALUES (?, ?)")
      .run(this.#digest(token), Number(token.split(".")[0]));
    return true;
  }

  cookie(token: string, secure = false): string {
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(this.options.sessionTtlMs / 1000)}${secure ? "; Secure" : ""}`;
  }

  static clearCookie(secure = false): string {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
  }

  #prune(now: number): void { this.db.query("DELETE FROM revoked_sessions WHERE expires_at <= ?").run(now); }
  #digest(token: string): string { return createHash("sha256").update(token).digest("hex"); }
  #sign(value: string): string { return createHmac("sha256", this.options.sessionSecret).update(value).digest("base64url"); }
  #signatureMatches(value: string, candidate: string): boolean {
    const expected = Buffer.from(this.#sign(value));
    const actual = Buffer.from(candidate);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}

/**
 * Serialises login attempts and slows them exponentially after failures.
 *
 * The old gate applied a fixed 500ms sleep *after* verifying, with nothing
 * stopping a thousand requests firing at once — so the whole 9,000-value space
 * was brute-forceable in parallel in seconds, and the API behind the gate can
 * drive terminal sessions. This makes every attempt wait for the one before it
 * (so concurrency buys nothing) and pushes a growing delay after each failure
 * (500ms, 1s, 2s … capped at 30s), resetting on the first success. Global
 * rather than per-source because, behind `tailscale serve`, every request
 * arrives from loopback anyway.
 */
export class LoginThrottle {
  #running: Promise<unknown> = Promise.resolve();
  #failures = 0;
  #nextAllowedAt = 0;

  async attempt(
    check: () => Promise<boolean>,
    sleep: (ms: number) => Promise<unknown> = (ms) => Bun.sleep(ms),
    now: () => number = Date.now,
  ): Promise<boolean> {
    const run = this.#running.then(async () => {
      const wait = this.#nextAllowedAt - now();
      if (wait > 0) await sleep(wait);
      const ok = await check();
      if (ok) {
        this.#failures = 0;
        this.#nextAllowedAt = 0;
      } else {
        this.#failures += 1;
        const backoff = Math.min(500 * 2 ** Math.min(this.#failures - 1, 6), 30_000);
        this.#nextAllowedAt = now() + backoff;
      }
      return ok;
    });
    // Keep the chain alive even if one attempt throws, so a failure does not
    // wedge the gate shut.
    this.#running = run.catch(() => {});
    return run;
  }
}

/** Reads one cookie out of a `Cookie` header. */
export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}
