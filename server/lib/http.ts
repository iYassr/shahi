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
import type { DashboardPane } from "@shahi/shared";
import type { Server, ServerWebSocket } from "bun";

export type { DashboardPane };
import { Auth, SESSION_COOKIE, readCookie } from "./auth";
import type { Config } from "./config";
import { HerdrError, SLOW_METHODS, type HerdrClient, type Method, type ParamsFor } from "./herdr-client";
import { forgetInstalledAgents, installedAgents, startAgentInTab } from "./agents";
import { compress } from "./compress";
import { readAgentPanelSort } from "./herdr-config";
import { readCodexLog } from "./codex-log";
import { previewFor, readSessionImage, readSessionLog } from "./session-log";
import { UploadTooLarge, storeUpload } from "./uploads";
import { OutsideHomeError, collapseHome, listDirectories } from "./dirs";
import { FileTooLarge, readWithinHome } from "./files";
import type { PaneFrame, Poller } from "./poller";
import type { PushService } from "./push";
import { STATUS_PRIORITY, type SessionState, type SessionStore } from "./state";
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

/**
 * How often to say something even when nothing has changed.
 *
 * Short enough that a client notices a dead connection within a few tens of
 * seconds, long enough to be nothing on a phone's battery or data.
 */
const HEARTBEAT_MS = 20_000;

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });

export function createServer(deps: HttpDeps): Server<SocketData> {
  const { config, auth, client, store, poller, transcript, push } = deps;
  const clients = new Set<Client>();

  // herdr's own agent-panel preference, cached rather than re-read on every
  // broadcast. Refreshed whenever the dashboard is fetched, so editing
  // config.toml takes effect on the next pull rather than needing a restart.
  let defaultGrouping: string | null = null;
  void readAgentPanelSort().then((value) => {
    defaultGrouping = value;
  });

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
      if (clients.size > 0) {
        void dashboard(store, poller, defaultGrouping).then((session) =>
          broadcast({ type: "session", session }),
        );
      }
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
      const response = await handle(req, srv);
      // Compression happens here and nowhere else: routes stay unaware of it,
      // and a websocket upgrade (which returns undefined) passes through.
      return response ? compress(req, response, compressionKey(response)) : response;
    },

    websocket: {
      // Comfortably longer than the heartbeat below, so only a genuinely dead
      // connection is ever closed for idling.
      idleTimeout: 90,

      // The session payload is 18KB of JSON and goes out on every change.
      perMessageDeflate: true,

      open(ws) {
        clients.add(ws);
        poller.setClientCount(clients.size);
        void dashboard(store, poller, defaultGrouping).then((session) =>
          ws.send(JSON.stringify({ type: "session", session })),
        );
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

  // See the `ping` message in the shared contract: silence has to be
  // distinguishable from a dead connection, and a phone's socket dies quietly.
  setInterval(() => {
    if (clients.size === 0) return;
    broadcast({ type: "ping", at: Date.now() });
  }, HEARTBEAT_MS);


  /**
   * Every request, before compression.
   *
   * Returns undefined for a websocket upgrade, which Bun takes as "already
   * handled".
   */
  async function handle(req: Request, srv: Server<SocketData>): Promise<Response | undefined> {
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
          defaultGrouping = await readAgentPanelSort();
          return json(await dashboard(store, poller, defaultGrouping));
        }

        // Choosing where a new space lives. Browsable, because typing a path on a
        // phone keyboard is its own small punishment.
        if (pathname === "/api/dirs") {
          try {
            return json(
              await listDirectories(url.searchParams.get("path") ?? "~", {
                includeFiles: url.searchParams.get("files") === "1",
              }),
            );
          } catch (err) {
            if (err instanceof OutsideHomeError) return json({ error: err.message }, { status: 403 });
            return json({ error: "cannot list that directory" }, { status: 404 });
          }
        }

        // Agent kinds that could actually start here. herdr knows how to detect
        // 19, but offering one that is not installed would just fail after a
        // 30-second wait for readiness that was never coming.
        if (pathname === "/api/agents") {
          if (url.searchParams.get("refresh") === "1") forgetInstalledAgents();
          const { manifests } = await client.rpc("server.agent_manifests", {});
          return json({
            agents: await installedAgents(manifests.map((m) => m.agent)),
            known: manifests.length,
          });
        }

        // Starting an agent is two herdr calls with a race between them, so it is
        // one call from here. See `startAgentInTab`.
        if (pathname === "/api/agents/start" && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as {
            workspaceId?: string;
            cwd?: string | null;
            label?: string | null;
            kind?: string;
            name?: string;
            mode?: string | null;
          };
          if (!body.workspaceId || !body.kind) {
            return json({ error: "workspaceId and kind are required" }, { status: 400 });
          }
          // herdr does not expand `~`; it silently uses $HOME instead, which puts
          // the agent somewhere the user did not ask for.
          if (body.cwd && !body.cwd.startsWith("/")) {
            return json({ error: "cwd must be an absolute path" }, { status: 400 });
          }
          try {
            const started = await startAgentInTab(
              (method, params, options) =>
                client.rpc(method as Method, params as ParamsFor<Method>, options) as never,
              {
                workspaceId: body.workspaceId,
                cwd: body.cwd ?? null,
                label: body.label ?? null,
                kind: body.kind,
                name: body.name ?? body.kind,
                // Forwarded, not implied: this was dropped here for months and
                // every agent silently started with default permissions — found
                // by ps on a live box showing bare `claude` after "Plan first"
                // was chosen. The picker was decorative without this line.
                mode: body.mode ?? null,
              },
            );
            return json(started);
          } catch (err) {
            if (err instanceof HerdrError) {
              return json({ error: err.message, code: err.code }, { status: 400 });
            }
            return json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
          }
        }

        /*
       * A file the agent touched, for reading or downloading.
       *
       * `Content-Disposition` decides which: inline lets the browser show it,
       * attachment makes it a download. Both are the same bytes; the reader
       * offers both because a phone can do more with a picture on screen than
       * with a file in Downloads, and more with a spreadsheet the other way
       * round.
       */
      if (pathname === "/api/file") {
        const path = url.searchParams.get("path");
        if (!path) return json({ error: "path is required" }, { status: 400 });

        const download = url.searchParams.get("download") === "1";
        try {
          const file = await readWithinHome({ path, download });
          const safeName = file.name.replace(/["\\]/g, "_");
          return new Response(file.bytes, {
            headers: {
              "content-type": file.contentType,
              "content-length": String(file.bytes.byteLength),
              "content-disposition": `${download ? "attachment" : "inline"}; filename="${safeName}"`,
              // The agent may rewrite it a second later.
              "cache-control": "no-store",
            },
          });
        } catch (err: unknown) {
          if (err instanceof FileTooLarge) return json({ error: err.message }, { status: 413 });
          if (err instanceof OutsideHomeError) return json({ error: err.message }, { status: 403 });
          return json({ error: "cannot read that file" }, { status: 404 });
        }
      }

      // A file sent from the phone. It lands in an owned directory and comes
        // back as an absolute path, which is all the agent needs — the same shape
        // as picking something already on the server.
        if (pathname === "/api/uploads" && req.method === "POST") {
          const form = await req.formData().catch(() => null);
          const file = form?.get("file");
          if (!(file instanceof File)) return json({ error: "no file supplied" }, { status: 400 });
          try {
            return json(await storeUpload(file));
          } catch (err) {
            if (err instanceof UploadTooLarge) return json({ error: err.message }, { status: 413 });
            return json({ error: "could not save the file" }, { status: 500 });
          }
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

        // The native app's channel. No VAPID, no service worker — Expo's push
        // service takes a token and hands the notification to FCM or APNs.
        if (pathname === "/api/push/expo" && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as { token?: unknown };
          if (!push.isExpoToken(body.token)) {
            return json({ error: "malformed expo push token" }, { status: 400 });
          }
          push.subscribeExpo(body.token);
          return json({ ok: true });
        }

        if (pathname === "/api/push/expo/unsubscribe" && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as { token?: unknown };
          if (typeof body.token === "string") push.unsubscribeExpo(body.token);
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

          // Claude Code's own structured transcript, when this pane has one.
          // Far better than the recorded screen: real messages, full history,
          // and tool calls already paired with their results.
          // An image out of the transcript, served rather than inlined.
          if (sub === "/image") {
            const sessionId = store.pane(paneId)?.agent_session?.value;
            const ref = url.searchParams.get("ref");
            if (!sessionId || !ref) return json({ error: "not found" }, { status: 404 });
            const image = await readSessionImage(sessionId, ref);
            if (!image) return json({ error: "not found" }, { status: 404 });
            return new Response(image.bytes, {
              headers: {
                "content-type": image.mediaType,
                // The transcript is append-only, so a given ref never changes.
                "cache-control": "private, max-age=31536000, immutable",
              },
            });
          }

          if (sub === "/session") {
            const pane = store.pane(paneId);
            const limit = Math.min(Number(url.searchParams.get("limit") ?? 60), 400);
            const before = url.searchParams.get("before")
              ? Number(url.searchParams.get("before"))
              : undefined;

            // Each agent keeps its transcript its own way, so the reader dispatches
            // on kind rather than assuming one format.
            const log =
              pane?.agent === "codex"
                ? await readCodexLog(client, paneId, pane.cwd ?? null, {
                    limit,
                    before,
                    sessionId: pane.agent_session?.value ?? null,
                  })
                : pane?.agent_session?.value
                  ? await readSessionLog(pane.agent_session.value, { limit, before })
                  : null;

            if (!log) {
              return json(
                { error: "no transcript for this pane", messages: [] },
                { status: 404 },
              );
            }

            /*
             * An ETag, because this is the app's most expensive request by a
             * wide margin: the reader polls every 2.5 seconds, and a busy pane
             * was sending 15KB of gzipped JSON each time — most of it identical
             * to the last one. With `no-cache` the browser revalidates on its
             * own and this becomes a 304 with no body whenever the conversation
             * has not moved, which is most polls.
             *
             * The tag is derived from the content rather than the file, since a
             * transcript can be assembled from more than one place.
             */
            const etag = `W/"${Bun.hash(JSON.stringify(log)).toString(36)}"`;
            if (req.headers.get("if-none-match") === etag) {
              return new Response(null, {
                status: 304,
                headers: { etag, "cache-control": "no-cache" },
              });
            }
            return json(log, { headers: { etag, "cache-control": "no-cache" } });
          }

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
            const method = body.method as Method;
            const result = await client.rpc(method, (body.params ?? {}) as ParamsFor<Method>, {
              // agent.start and friends block waiting for something to happen;
              // the default ceiling would fail them every time.
              timeoutMs: SLOW_METHODS[method],
            });
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
  }

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


export async function dashboard(store: SessionStore, poller: Poller, defaultGrouping: string | null = null) {
  const { state } = store;

  const panes: DashboardPane[] = await Promise.all(state.panes.map(async (pane) => ({
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
    // The last thing said, for chat-style rows. The transcript index caches by
    // file size, so a quiet pane costs one stat here.
    preview: pane.agent_session?.value
      ? await previewFor(pane.agent_session.value).catch(() => null)
      : null,
    activity: poller.frame(pane.pane_id)?.activity ?? null,
  })));

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
    // What herdr's own agent panel is set to, so the phone opens the way the
    // TUI already does. Null when no preference is stated.
    defaultGrouping,
    workspaces: state.workspaces.map((w) => ({
      workspaceId: w.workspace_id,
      label: w.label,
      status: w.agent_status,
      paneCount: w.pane_count,
      tabCount: w.tab_count,
      focused: w.focused,
      // Where the space lives, taken from its first pane. herdr keeps the
      // canonical path on the worktree record, which most spaces do not have.
      //
      // Both forms: `cwd` is for display, `cwdPath` is what may be sent back to
      // herdr. herdr does not expand `~` — it silently falls back to $HOME —
      // so anything round-tripped into workspace.create must be absolute.
      cwd: firstCwd(state, w.workspace_id),
      cwdPath: state.panes.find((p) => p.workspace_id === w.workspace_id && p.cwd)?.cwd ?? null,
    })),
    tabs: state.tabs.map((t) => ({
      tabId: t.tab_id,
      workspaceId: t.workspace_id,
      label: t.label,
      number: t.number,
      status: t.agent_status,
      paneCount: t.pane_count,
      focused: t.focused,
    })),
    panes,
    focusedPaneId: state.focusedPaneId,
  };
}

/** Display path for a space, derived from a pane inside it. */
function firstCwd(state: SessionState, workspaceId: string): string | null {
  const cwd = state.panes.find((p) => p.workspace_id === workspaceId && p.cwd)?.cwd;
  return cwd ? collapseHome(cwd) : null;
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

/**
 * A cache key for compressed bytes, or undefined for anything that changes.
 *
 * Only immutable assets qualify — their URL already contains a content hash, so
 * a different build is a different key and there is nothing to invalidate.
 */
function compressionKey(response: Response): string | undefined {
  const control = response.headers.get("cache-control") ?? "";
  if (!control.includes("immutable")) return undefined;
  return response.headers.get("etag") ?? response.headers.get("x-asset") ?? undefined;
}

async function serveStatic(pathname: string, webRoot: string | null): Promise<Response> {
  if (!webRoot) {
    return new Response("Shahi API is running. Build the frontend to serve the app.", {
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
    const immutable = /\.[0-9a-f]{8,}\./.test(relative);
    return new Response(candidate, {
      headers: {
        "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
        // Names the asset for the compressed-bytes cache; the hash in the
        // filename is what makes it safe.
        ...(immutable ? { "x-asset": relative } : {}),
        // Hashed asset filenames may be cached hard; everything else must not
        // be, or a stale service worker outlives a deploy.
        "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
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
