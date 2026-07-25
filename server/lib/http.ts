/**
 * HTTP and WebSocket surface.
 *
 * Bound to loopback; `tailscale serve` fronts it with TLS and restricts reach to
 * the tailnet. Everything behind the passcode gate has full control over herdr,
 * so the gate is checked on every request and on the WebSocket upgrade.
 *
 * Terminal output is never logged: these screens carry whatever is in the user's
 * terminals, including secrets.
 */
import type { Server, ServerWebSocket } from "bun";
import { Auth, SESSION_COOKIE, readCookie } from "./auth";
import type { Config } from "./config";
import { HerdrError, type HerdrClient, type Method, type ParamsFor } from "./herdr-client";
import type { PaneFrame, Poller } from "./poller";
import type { ParsedPrompt } from "./prompt-parser";
import type { PushService } from "./push";
import { STATUS_PRIORITY, type SessionStore } from "./state";
import type { TranscriptStore } from "./transcript";

interface SocketData {
  /** Pane this client currently has open, if any. */
  watchedPaneId: string | null;
  releaseWatch: (() => void) | null;
}

type Client = ServerWebSocket<SocketData>;

export interface HttpDeps {
  config: Config;
  auth: Auth;
  client: HerdrClient;
  store: SessionStore;
  poller: Poller;
  transcript: TranscriptStore;
  push: PushService;
}

/**
 * How long to batch dashboard updates before pushing them.
 *
 * Fast enough that a status change feels immediate, slow enough that herdr's
 * event firehose does not become the client's problem.
 */
const SESSION_BROADCAST_INTERVAL_MS = 250;

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });

export function createServer(deps: HttpDeps): Server<SocketData> {
  const { config, auth, client, store, poller, transcript, push } = deps;
  const clients = new Set<Client>();

  const authorized = (req: Request) =>
    auth.verifyToken(readCookie(req.headers.get("cookie"), SESSION_COOKIE));

  const broadcast = (message: unknown) => {
    const payload = JSON.stringify(message);
    for (const ws of clients) ws.send(payload);
  };

  // Push state changes to every connected client. The payload is the dashboard
  // projection rather than the raw mirror: phones do not need 27 panes of
  // detail to render a list.
  //
  // Coalesced, because herdr is chatty: the live session emits a few hundred
  // events a minute, and a naive relay sent 16 full dashboards in the first
  // half-second of a connection. Nobody can read a list changing 30 times a
  // second, and on cellular it is pure cost.
  let sessionBroadcastTimer: ReturnType<typeof setTimeout> | undefined;
  store.on("changed", () => {
    if (sessionBroadcastTimer) return;
    sessionBroadcastTimer = setTimeout(() => {
      sessionBroadcastTimer = undefined;
      if (clients.size > 0) broadcast({ type: "session", session: dashboard(store, poller) });
    }, SESSION_BROADCAST_INTERVAL_MS);
  });

  // Frames go only to clients watching that pane. A screen is ~3.5KB and there
  // are 27 of them; broadcasting all of it would swamp a phone on cellular.
  poller.on("frame", (frame: PaneFrame) => {
    const payload = JSON.stringify({ type: "frame", frame });
    for (const ws of clients) {
      if (ws.data.watchedPaneId === frame.paneId) ws.send(payload);
    }
  });

  // A prompt appearing is worth telling every client about, watching or not:
  // it is what turns a dashboard card into something actionable.
  poller.on("frame", (frame: PaneFrame) => {
    if (frame.prompt) broadcast({ type: "prompt", paneId: frame.paneId, prompt: frame.prompt });
  });

  store.on("status", (change) => {
    broadcast({ type: "status", change });
    void push.notifyStatusChange(change, store);
  });

  const server = Bun.serve<SocketData, never>({
    hostname: config.host,
    port: config.port,

    async fetch(req, srv) {
      const url = new URL(req.url);
      const { pathname } = url;

      // --- unauthenticated ---
      if (pathname === "/api/auth/status") {
        return json({ required: !auth.disabled, authenticated: authorized(req) });
      }

      if (pathname === "/api/auth/login" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { passcode?: string };
        if (!(await auth.verifyPasscode(body.passcode ?? ""))) {
          // Blunt but effective against an unattended phone being guessed at.
          await Bun.sleep(500);
          return json({ error: "invalid passcode" }, { status: 401 });
        }
        return json({ ok: true }, { headers: { "set-cookie": auth.cookie(auth.issue()) } });
      }

      if (pathname === "/api/auth/logout" && req.method === "POST") {
        return json({ ok: true }, { headers: { "set-cookie": Auth.clearCookie() } });
      }

      // --- everything below requires a session ---
      if (pathname.startsWith("/api/") || pathname === "/ws") {
        if (!authorized(req)) return json({ error: "unauthorized" }, { status: 401 });
      }

      if (pathname === "/ws") {
        const upgraded = srv.upgrade(req, {
          data: { watchedPaneId: null, releaseWatch: null } satisfies SocketData,
        });
        return upgraded ? undefined : new Response("expected a websocket upgrade", { status: 400 });
      }

      if (pathname === "/api/session") {
        return json(dashboard(store, poller));
      }

      if (pathname === "/api/push/key") {
        return json({ publicKey: push.publicKey });
      }

      if (pathname === "/api/push/subscribe" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        if (!push.isSubscription(body)) return json({ error: "malformed subscription" }, { status: 400 });
        push.subscribe(body);
        return json({ ok: true });
      }

      if (pathname === "/api/push/unsubscribe" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { endpoint?: string };
        if (body.endpoint) push.unsubscribe(body.endpoint);
        return json({ ok: true });
      }

      if (pathname === "/api/push/test" && req.method === "POST") {
        const sent = await push.sendTest();
        return json({ sent });
      }

      const paneMatch = pathname.match(/^\/api\/panes\/([^/]+)(\/[a-z]+)?$/);
      if (paneMatch) {
        const paneId = decodeURIComponent(paneMatch[1]!);
        const sub = paneMatch[2];

        if (!store.pane(paneId)) return json({ error: "no such pane" }, { status: 404 });

        if (sub === "/transcript") {
          const before = url.searchParams.get("before");
          const limit = Math.min(Number(url.searchParams.get("limit") ?? 500), 2_000);
          const lines = before
            ? transcript.before(paneId, Number(before), limit)
            : transcript.tail(paneId, limit);
          return json({ paneId, lines, total: transcript.count(paneId) });
        }

        if (!sub) {
          // A pane opened cold may have no frame yet; read it now rather than
          // making the phone wait for the next poll tick.
          const frame = poller.frame(paneId) ?? (await poller.refresh(paneId));
          return json({
            pane: store.pane(paneId),
            agent: store.agent(paneId),
            layout: store.layoutForPane(paneId),
            frame: frame ?? null,
          });
        }
      }

      // Full control, as chosen: any herdr method may be invoked. The gate above
      // is the boundary, not an allowlist here.
      if (pathname === "/api/rpc" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { method?: string; params?: unknown };
        if (!body.method) return json({ error: "method is required" }, { status: 400 });
        try {
          const result = await client.rpc(
            body.method as Method,
            (body.params ?? {}) as ParamsFor<Method>,
          );
          return json({ result });
        } catch (err) {
          if (err instanceof HerdrError) {
            return json({ error: err.message, code: err.code }, { status: 400 });
          }
          return json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
        }
      }

      if (pathname.startsWith("/api/")) return json({ error: "not found" }, { status: 404 });

      return serveStatic(pathname, config.webRoot);
    },

    websocket: {
      open(ws) {
        clients.add(ws);
        poller.setClientCount(clients.size);
        ws.send(JSON.stringify({ type: "session", session: dashboard(store, poller) }));
      },

      close(ws) {
        ws.data.releaseWatch?.();
        clients.delete(ws);
        poller.setClientCount(clients.size);
      },

      message(ws, raw) {
        let msg: { type?: string; paneId?: string };
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }

        if (msg.type === "watch" && msg.paneId) {
          watch(ws, msg.paneId);
        } else if (msg.type === "unwatch") {
          ws.data.releaseWatch?.();
          ws.data.releaseWatch = null;
          ws.data.watchedPaneId = null;
        }
      },
    },
  });

  function watch(ws: Client, paneId: string): void {
    // Releasing before acquiring would drop the watch count to zero and let the
    // pane fall back to the slow interval between two views of the same pane.
    const previous = ws.data.releaseWatch;
    ws.data.releaseWatch = poller.watch(paneId);
    ws.data.watchedPaneId = paneId;
    previous?.();

    const frame = poller.frame(paneId);
    if (frame) ws.send(JSON.stringify({ type: "frame", frame }));
    else void poller.refresh(paneId);
  }

  return server;
}

/** What a phone needs to render the dashboard, and no more. */
export interface DashboardPane {
  paneId: string;
  workspaceId: string;
  workspaceLabel: string;
  tabId: string;
  status: string;
  agent: string | null;
  title: string | null;
  cwd: string | null;
  focused: boolean;
  hasPrompt: boolean;
  /**
   * The parsed prompt, for blocked panes only.
   *
   * Carried in the dashboard payload rather than left to arrive on the next
   * frame: a phone opening from a notification must be able to answer
   * immediately, and frames only stream for the pane a client is watching.
   */
  prompt: ParsedPrompt | null;
  /** False for plain shells. Roughly half the panes in a real session are not
   *  agents at all, and a dashboard that lists them alongside agents buries the
   *  thing you opened it for. */
  isAgent: boolean;
}

export function dashboard(store: SessionStore, poller: Poller) {
  const { state } = store;

  const panes: DashboardPane[] = state.panes.map((pane) => ({
    paneId: pane.pane_id,
    workspaceId: pane.workspace_id,
    workspaceLabel: store.workspace(pane.workspace_id)?.label ?? pane.workspace_id,
    tabId: pane.tab_id,
    status: pane.agent_status,
    agent: pane.display_agent ?? pane.agent ?? null,
    // `terminal_title_stripped` is already a good human summary of what an agent
    // is doing ("Convert PDF to verbatim markdown"), which is exactly what a
    // dashboard card and a notification both want.
    title: pane.terminal_title_stripped ?? pane.terminal_title ?? pane.label ?? null,
    cwd: pane.cwd ?? null,
    focused: pane.focused,
    hasPrompt: poller.frame(pane.pane_id)?.prompt != null,
    prompt: pane.agent_status === "blocked" ? (poller.frame(pane.pane_id)?.prompt ?? null) : null,
    isAgent: store.agent(pane.pane_id) !== undefined,
  }));

  panes.sort(
    (a, b) =>
      (STATUS_PRIORITY[a.status as keyof typeof STATUS_PRIORITY] ?? 9) -
        (STATUS_PRIORITY[b.status as keyof typeof STATUS_PRIORITY] ?? 9) ||
      a.workspaceLabel.localeCompare(b.workspaceLabel) ||
      a.paneId.localeCompare(b.paneId),
  );

  return {
    version: state.version,
    protocol: state.protocol,
    workspaces: state.workspaces.map((w) => ({
      workspaceId: w.workspace_id,
      label: w.label,
      status: w.agent_status,
      paneCount: w.pane_count,
      focused: w.focused,
    })),
    panes,
    focusedPaneId: state.focusedPaneId,
  };
}

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  webmanifest: "application/manifest+json",
};

async function serveStatic(pathname: string, webRoot: string | null): Promise<Response> {
  if (!webRoot) {
    return new Response("HerdrUI API is running. Build the frontend to serve the app.", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // Reject traversal before touching the filesystem.
  const relative = pathname.replace(/^\/+/, "");
  if (relative.split("/").some((segment) => segment === "..")) {
    return new Response("forbidden", { status: 403 });
  }

  const candidate = Bun.file(`${webRoot}/${relative}`);
  if (relative !== "" && (await candidate.exists())) {
    const ext = relative.slice(relative.lastIndexOf(".") + 1);
    return new Response(candidate, {
      headers: {
        "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
        // Hashed asset filenames may be cached hard; everything else must not
        // be, or a stale service worker outlives a deploy.
        "cache-control": /\.[0-9a-f]{8,}\./.test(relative)
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      },
    });
  }

  // Client-side routing: unknown paths fall through to the app shell.
  const index = Bun.file(`${webRoot}/index.html`);
  if (await index.exists()) {
    return new Response(index, {
      headers: { "content-type": CONTENT_TYPES.html!, "cache-control": "no-cache" },
    });
  }
  return new Response("not found", { status: 404 });
}
