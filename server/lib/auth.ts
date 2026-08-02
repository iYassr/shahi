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
