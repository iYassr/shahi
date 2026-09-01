/**
 * A small in-memory rate limiter for the routes that answer before the
 * passcode gate.
 *
 * Everything behind the gate is one person with a cookie, and the login route
 * already has `LoginThrottle`. What was uncovered were the handful of routes
 * that answer anyone — `/api/meta`, `/api/auth/status`, and the pairing routes
 * on their way — which on a tailnet is a nuisance and on a public tunnel is
 * free fingerprinting and a cheap way to keep the process busy. Keyed by client
 * address; a fixed window is enough here, because the legitimate rate is one
 * or two calls per app launch and the ceiling only has to be far below what a
 * scanner would send.
 */

/**
 * The paths that are limited. Exact strings match one path; a trailing slash
 * matches the whole subtree. Adding a route is adding one line here.
 */
export const RATE_LIMITED_PATHS = ["/api/meta", "/api/auth/status", "/api/pair/"];

export function isRateLimitedPath(pathname: string, paths: readonly string[] = RATE_LIMITED_PATHS): boolean {
  return paths.some((p) => (p.endsWith("/") ? pathname.startsWith(p) : pathname === p));
}

export interface RateLimitOptions {
  /** Requests allowed per key per window. */
  limit?: number;
  windowMs?: number;
  /** Keys held before the oldest are dropped — a bound, not a working size. */
  maxKeys?: number;
}

export class RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #maxKeys: number;
  readonly #windows = new Map<string, { start: number; count: number }>();

  constructor({ limit = 30, windowMs = 60_000, maxKeys = 10_000 }: RateLimitOptions = {}) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#maxKeys = maxKeys;
  }

  /**
   * Records one request for `key`. Returns `null` when it is allowed, or the
   * number of milliseconds until the window reopens when it is not.
   */
  hit(key: string, now = Date.now()): number | null {
    const held = this.#windows.get(key);
    const window = held && now - held.start < this.#windowMs ? held : { start: now, count: 0 };
    window.count += 1;

    // Re-inserted so Map order is most-recently-seen last, which makes the
    // eviction below drop the stalest keys first.
    this.#windows.delete(key);
    this.#windows.set(key, window);
    if (this.#windows.size > this.#maxKeys) {
      for (const stale of [...this.#windows.keys()].slice(0, this.#windows.size - this.#maxKeys)) {
        this.#windows.delete(stale);
      }
    }

    return window.count > this.#limit ? window.start + this.#windowMs - now : null;
  }
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * The address a request came from, as far as this process can tell.
 *
 * Behind `tailscale serve` or `cloudflared` every connection is from loopback
 * and the real peer is in `x-forwarded-for`; the header is believed only then,
 * because from anywhere else it is just a header the client typed. Direct
 * tailnet binds see the peer itself.
 *
 * The *last* hop, not the first. A proxy appends the address it saw to
 * whatever `x-forwarded-for` the client already sent (Go's reverse proxy and
 * Cloudflare both do), so the first entry is the client's to choose and the
 * last is the proxy's — and a limiter keyed on the first was a limiter the
 * client could reset per request by rotating the header. Caught in review.
 */
export function clientAddress(peer: string | null, forwardedFor: string | null, bindHost: string | null = null): string {
  // Loopback is the proxy's address when this server binds 127.0.0.1; when it
  // binds the tailnet IP (as docs/operations.md configures with `tailscale
  // serve … http://<tailnet-ip>:7171`), tailscaled dials that address, so the
  // peer is the box's own IP and every client would have shared one bucket.
  const viaProxy = peer !== null && (LOOPBACK.has(peer) || (bindHost !== null && peer === bindHost));
  if (viaProxy && forwardedFor) {
    const last = forwardedFor.split(",").at(-1)?.trim();
    if (last) return last;
  }
  return peer ?? "unknown";
}
