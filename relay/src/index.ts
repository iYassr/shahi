/**
 * The blind relay's front door. Two paths upgrade to WebSockets and hand the
 * socket to the Durable Object named after the box; everything else is a 404.
 * The Worker itself holds no state and reads no frame — `box.ts` is where the
 * protocol lives, and `docs/relay.md` is what it implements.
 */
import { RelayBox } from "./box.ts";
import { hstsHeaders } from "./hsts.ts";
import { connectLimitKey } from "./limits.ts";
import { ROUTE } from "./route.ts";
import { handleStats, record, type TelemetryEnv } from "./telemetry.ts";

export { RelayBox };

export interface Env extends TelemetryEnv {
  RELAY: DurableObjectNamespace<RelayBox>;
  OPERATIONS?: Fetcher;
  /**
   * A per-IP connection limiter at the edge, before a Durable Object is even
   * addressed. Optional: absent in `wrangler dev` and the test harness, set in
   * production `wrangler.toml`. It is the cheap first wall against the
   * unauthenticated amplification in pentest C1 — a stranger opening sockets
   * to arbitrary serverIds to burn the account's daily quota and take every
   * box offline. This is per IPv4 address or IPv6 /64 at each edge location
   * and eventually consistent, not a global usage or billing ceiling. Account
   * limits and WAF rules are separate operational controls.
   */
  CONNECT_LIMIT?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
}

/** base64url(sha256(pub)) is 32 bytes unpadded: exactly 43 characters of the base64url alphabet. */
const SERVER_ID = /^[A-Za-z0-9_-]{43}$/;

/**
 * Whether a request came through Cloudflare's edge from a real client, rather
 * than from `wrangler dev` or the tests on this machine. Cloudflare sets
 * `cf-connecting-ip` to the visitor's address, which a client cannot spoof and
 * is never loopback there; locally it is loopback or absent. The URL cannot
 * tell them apart: `wrangler dev` hands the Worker its first route's host over
 * plain HTTP (`http://relay.getshahi.dev/…`, measured with wrangler 4.129),
 * which is exactly what a cleartext visitor looks like in production.
 */
function fromEdge(request: Request): string | null {
  const ip = request.headers.get("cf-connecting-ip");
  return ip && ip !== "127.0.0.1" && ip !== "::1" ? ip : null;
}

export default {
  async fetch(request, env): Promise<Response> {
    // Plain HTTP from the edge goes to HTTPS before it is routed. The zone's
    // "Always Use HTTPS" does this too, but it was off for relay.getshahi.dev,
    // which then answered /health and upgraded ws:// to a live link in
    // cleartext (pre-release bug hunt, B51). A relay deployed to someone
    // else's zone is in the same position, so the relay does not depend on
    // the setting. A WebSocket client does not follow the redirect: a
    // cleartext upgrade simply fails, which is the point.
    const url = new URL(request.url);
    if (url.protocol === "http:" && fromEdge(request)) {
      url.protocol = "https:";
      return new Response(null, { status: 301, headers: { location: url.href } });
    }
    const response = await route(request, env);
    // The upgrade is the object's own response, which carries the header
    // already; it is passed through untouched so its WebSocket goes with it.
    if (response.status === 101) return response;
    const secured = new Response(response.body, response);
    for (const [name, value] of Object.entries(hstsHeaders(request))) secured.headers.set(name, value);
    return secured;
  },
} satisfies ExportedHandler<Env>;

/** Every path the relay answers, before the headers every response shares. */
async function route(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  const synthetic = !!env.STATS_TOKEN && request.headers.get("x-shahi-probe") === env.STATS_TOKEN;
  if (path === "/health") {
    // HEAD as well as GET: uptime monitors commonly send HEAD, and it fell
    // through to the 404 (pre-release bug hunt, B106).
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    return Response.json({ ok: true, service: "shahi-relay" }, { headers: { "cache-control": "no-store" } });
  }
  // A read of the fleet telemetry, off the hot path. Hidden unless a token
  // is set (see telemetry.ts); never touches a Durable Object.
  if (path === "/stats") return (await handleStats(request, env)) ?? new Response("not found", { status: 404 });
  if (path === "/ops/status" || path === "/ops/check" || path === "/ops/test-alert") {
    if (!env.STATS_TOKEN || !env.OPERATIONS) return new Response("not found", { status: 404 });
    if (request.headers.get("authorization") !== `Bearer ${env.STATS_TOKEN}`) return new Response("unauthorized", { status: 401 });
    const response = await env.OPERATIONS.fetch(new Request(`https://operations/${path.split("/").pop()}`, { method: request.method }));
    return new Response(response.body, { status: response.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
  const match = ROUTE.exec(path);
  if (!match) return new Response("not found", { status: 404 });
  const serverId = match[2]!;
  if (!SERVER_ID.test(serverId)) {
    return new Response("serverId must be 43 base64url characters", { status: 400 });
  }
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("expected a WebSocket upgrade", { status: 426 });
  }
  // Rate the source before addressing an object: an over-quota IP is refused
  // here, so a flood of connects to random serverIds cannot each spin up a
  // Durable Object and burn the account's daily quota (pentest C1). Only real
  // edge traffic is rated (see fromEdge): `wrangler dev` and the test harness
  // are not a threat surface. IPv6 sources are counted by their /64 (see
  // connectLimitKey).
  const ip = fromEdge(request);
  if (env.CONNECT_LIMIT && ip) {
    const { success } = await env.CONNECT_LIMIT.limit({ key: connectLimitKey(ip) });
    if (!success) {
      record(env, { synthetic, kind: "rate_limited", serverId, colo: coloOf(request) });
      return new Response("too many connections; slow down", { status: 429 });
    }
  }
  // A connection that passed the wall and is being routed: raw volume, by
  // region and role, for the "how busy / who is hammering" view.
  record(env, { synthetic, kind: "connect", serverId, detail: match[1]!, colo: coloOf(request) });
  // One object per serverId, addressed by the id itself: a box and its
  // phones land on the same instance wherever in the world they connect.
  try { return await env.RELAY.get(env.RELAY.idFromName(serverId)).fetch(request); }
  catch {
    record(env, { synthetic, kind: "internal_error", serverId });
    return new Response("relay unavailable", { status: 503, headers: { "retry-after": "5" } });
  }
}

/** The Cloudflare colo (data centre) a request landed in, for a by-region view. */
function coloOf(request: Request): string {
  return (request.cf?.colo as string | undefined) ?? "";
}
