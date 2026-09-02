/**
 * The blind relay's front door. Two paths upgrade to WebSockets and hand the
 * socket to the Durable Object named after the box; everything else is a 404.
 * The Worker itself holds no state and reads no frame — `box.ts` is where the
 * protocol lives, and `docs/relay.md` is what it implements.
 */
import { RelayBox } from "./box.ts";
import { ROUTE } from "./route.ts";

export { RelayBox };

export interface Env {
  RELAY: DurableObjectNamespace<RelayBox>;
  /**
   * A per-IP connection limiter at the edge, before a Durable Object is even
   * addressed. Optional: absent in `wrangler dev` and the test harness, set in
   * production `wrangler.toml`. It is the cheap first wall against the
   * unauthenticated amplification in pentest C1 — a stranger opening sockets
   * to arbitrary serverIds to burn the account's daily quota and take every
   * box offline. The real ceiling is a paid plan plus a WAF rule; this bounds
   * the per-source rate so one host cannot do it alone.
   */
  CONNECT_LIMIT?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
}

/** base64url(sha256(pub)) is 32 bytes unpadded: exactly 43 characters of the base64url alphabet. */
const SERVER_ID = /^[A-Za-z0-9_-]{43}$/;

export default {
  async fetch(request, env): Promise<Response> {
    const match = ROUTE.exec(new URL(request.url).pathname);
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
      if (!success) return new Response("too many connections; slow down", { status: 429 });
    }
    // One object per serverId, addressed by the id itself: a box and its
    // phones land on the same instance wherever in the world they connect.
    return env.RELAY.get(env.RELAY.idFromName(serverId)).fetch(request);
  },
} satisfies ExportedHandler<Env>;
