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
    // One object per serverId, addressed by the id itself: a box and its
    // phones land on the same instance wherever in the world they connect.
    return env.RELAY.get(env.RELAY.idFromName(serverId)).fetch(request);
  },
} satisfies ExportedHandler<Env>;
