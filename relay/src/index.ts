/**
 * The blind relay's front door. Two paths upgrade to WebSockets and hand the
 * socket to the Durable Object named after the box; everything else is a 404.
 * The Worker itself holds no state and reads no frame — `box.ts` is where the
 * protocol lives, and `docs/relay.md` is what it implements.
 */
import { RelayBox } from "./box.ts";
import { ROUTE } from "./route.ts";
import { handleStats, record, type TelemetryEnv } from "./telemetry.ts";

export { RelayBox };

export interface Env extends TelemetryEnv {
  RELAY: DurableObjectNamespace<RelayBox>;
  /**
   * A per-IP connection limiter at the edge, before a Durable Object is even
   * addressed. Optional: absent in `wrangler dev` and the test harness, set in
   * production `wrangler.toml`. It is the cheap first wall against the
   * unauthenticated amplification in pentest C1 — a stranger opening sockets
   * to arbitrary serverIds to burn the account's daily quota and take every
   * box offline. This is per IP at each edge location and eventually
   * consistent, not a global usage or billing ceiling. Account limits and
   * WAF rules are separate operational controls.
   */
  CONNECT_LIMIT?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
}

/** base64url(sha256(pub)) is 32 bytes unpadded: exactly 43 characters of the base64url alphabet. */
const SERVER_ID = /^[A-Za-z0-9_-]{43}$/;

export default {
  async fetch(request, env): Promise<Response> {
    const path = new URL(request.url).pathname;
    // A read of the fleet telemetry, off the hot path. Hidden unless a token
    // is set (see telemetry.ts); never touches a Durable Object.
    if (path === "/stats") return (await handleStats(request, env)) ?? new Response("not found", { status: 404 });
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
    // edge traffic is rated: `cf-connecting-ip` is set by Cloudflare and cannot
    // be spoofed there, while `wrangler dev` and the test harness present a
    // loopback address, which is not a threat surface and is skipped.
    const ip = request.headers.get("cf-connecting-ip");
    if (env.CONNECT_LIMIT && ip && ip !== "127.0.0.1" && ip !== "::1") {
      const { success } = await env.CONNECT_LIMIT.limit({ key: ip });
      if (!success) {
        record(env, { kind: "rate_limited", serverId, colo: coloOf(request) });
        return new Response("too many connections; slow down", { status: 429 });
      }
    }
    // A connection that passed the wall and is being routed: raw volume, by
    // region and role, for the "how busy / who is hammering" view.
    record(env, { kind: "connect", serverId, detail: match[1]!, colo: coloOf(request) });
    // One object per serverId, addressed by the id itself: a box and its
    // phones land on the same instance wherever in the world they connect.
    return env.RELAY.get(env.RELAY.idFromName(serverId)).fetch(request);
  },
} satisfies ExportedHandler<Env>;

/** The Cloudflare colo (data centre) a request landed in, for a by-region view. */
function coloOf(request: Request): string {
  return (request.cf?.colo as string | undefined) ?? "";
}
