/**
 * Passcode gate.
 *
 * Tailscale authenticates the *device*; this authenticates the person holding
 * it. That distinction matters because the API behind this proxies all of
 * herdr's methods, and `pane.send_text` alone is arbitrary shell execution as
 * the user — so an unlocked phone in someone else's hand is the threat this
 * exists to stop.
 *
 * Sessions are stateless: an HMAC-signed `expiry.signature` cookie. There is one
 * user and one device class here; a session table would add moving parts without
 * adding safety.
 */
import { password as bunPassword } from "bun";
import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "shahi_session";

export interface AuthOptions {
  passcodeHash: string;
  sessionSecret: string;
  sessionTtlMs: number;
}

export class Auth {
  constructor(private readonly options: AuthOptions) {}

  /** True when no passcode is configured and the gate is open. */
  get disabled(): boolean {
    return this.options.passcodeHash === "";
  }

  static async hashPasscode(passcode: string): Promise<string> {
    return bunPassword.hash(passcode, { algorithm: "bcrypt", cost: 12 });
  }

  async verifyPasscode(passcode: string): Promise<boolean> {
    if (this.disabled) return true;
    try {
      return await bunPassword.verify(passcode, this.options.passcodeHash);
    } catch {
      // A malformed hash in .env must not read as a successful login.
      return false;
    }
  }

  /** Mints a signed token valid for `sessionTtlMs`. */
  issue(now = Date.now()): string {
    const expiry = String(now + this.options.sessionTtlMs);
    return `${expiry}.${this.#sign(expiry)}`;
  }

  verifyToken(token: string | undefined, now = Date.now()): boolean {
    if (this.disabled) return true;
    if (!token) return false;

    const separator = token.lastIndexOf(".");
    if (separator <= 0) return false;

    const expiry = token.slice(0, separator);
    const signature = token.slice(separator + 1);

    // Check the signature before trusting the expiry it protects.
    if (!this.#signatureMatches(expiry, signature)) return false;

    const expiresAt = Number(expiry);
    return Number.isFinite(expiresAt) && expiresAt > now;
  }

  cookie(token: string): string {
    const maxAge = Math.floor(this.options.sessionTtlMs / 1000);
    // No `Secure`: tailscale serve terminates TLS and forwards over loopback
    // plain HTTP, and the same build has to work when reached directly at
    // 127.0.0.1 during development.
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
  }

  static clearCookie(): string {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  }

  #sign(value: string): string {
    return createHmac("sha256", this.options.sessionSecret).update(value).digest("base64url");
  }

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
