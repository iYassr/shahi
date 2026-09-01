/**
 * Passcode gate.
 *
 * Tailscale authenticates the *device*; this authenticates the person holding
 * it. That distinction matters because the API behind this proxies all of
 * herdr's methods, and `pane.send_text` alone is arbitrary shell execution as
 * the user — so an unlocked phone in someone else's hand is the threat this
 * exists to stop.
 *
 * Sessions are stateless: an HMAC-signed `expiry[.deviceId].signature` cookie.
 * There is one user, so there is no session table — but a phone that paired by
 * scanning a code carries its device id in the token, and `deviceActive` is
 * asked about it on every request. That is what makes revoking a phone take
 * effect on its next request rather than when its cookie runs out, without a
 * table of live sessions to keep in step.
 */
import { password as bunPassword } from "bun";
import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "shahi_session";

export interface AuthOptions {
  passcodeHash: string;
  sessionSecret: string;
  sessionTtlMs: number;
  /**
   * Whether a paired device may still act. Consulted every time a token that
   * names a device is checked. Absent means every device token is accepted
   * for as long as it is valid — fine for tests, never for the server.
   */
  deviceActive?: (deviceId: string) => boolean;
}

/** Who a valid token belongs to: a paired device, or a passcode login (null). */
export interface Identity {
  deviceId: string | null;
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

  /**
   * Mints a signed token valid for `sessionTtlMs`, bound to a device when the
   * session came from pairing. The id rides inside the signed part, so a token
   * cannot be re-pointed at another device any more than its expiry can be
   * extended.
   */
  issue(now = Date.now(), deviceId: string | null = null): string {
    const expiry = String(now + this.options.sessionTtlMs);
    const claims = deviceId ? `${expiry}.${deviceId}` : expiry;
    return `${claims}.${this.#sign(claims)}`;
  }

  verifyToken(token: string | undefined, now = Date.now()): boolean {
    return this.identify(token, now) !== null;
  }

  /**
   * Who is behind a token, or null when it does not grant a session.
   *
   * With the gate disabled everything is a session, but a valid device token
   * still says which device — Settings can then name the phone it is on.
   */
  identify(token: string | undefined, now = Date.now()): Identity | null {
    const open: Identity | null = this.disabled ? { deviceId: null } : null;
    if (!token) return open;

    const separator = token.lastIndexOf(".");
    if (separator <= 0) return open;

    const claims = token.slice(0, separator);
    const signature = token.slice(separator + 1);

    // Check the signature before trusting anything it protects.
    if (!this.#signatureMatches(claims, signature)) return open;

    const dot = claims.indexOf(".");
    const expiry = dot === -1 ? claims : claims.slice(0, dot);
    const deviceId = dot === -1 ? null : claims.slice(dot + 1);

    const expiresAt = Number(expiry);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return open;
    if (deviceId !== null && (deviceId === "" || !(this.options.deviceActive?.(deviceId) ?? true))) return open;
    return { deviceId };
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
