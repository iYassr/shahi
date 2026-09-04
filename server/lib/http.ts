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
import {
  SHAHI_API_VERSION,
  type ClaimResult,
  type DashboardPane,
  type DeviceList,
  type PairedDevice,
  type PromptReceipt,
  type ServerInfo,
} from "@shahi/shared";
import pkg from "../package.json" with { type: "json" };

export type { DashboardPane };
import { Auth, LoginThrottle, SESSION_COOKIE, readCookie } from "./auth";
import type { Config } from "./config";
import { HerdrError, SLOW_METHODS, type HerdrClient, type Method, type ParamsFor } from "./herdr-client";
import { forgetInstalledAgents, installedAgents, startAgentInTab } from "./agents";
import { compress } from "./compress";
import { readAgentPanelSort } from "./herdr-config";
import { findCodexRollout, readCodexLog } from "./codex-log";
import { findTranscript, previewFor, readSessionImage, readSessionLog } from "./session-log";
import { isLoopback } from "./endpoint";
import { PromptReceipts, submitPrompt } from "./prompt";
import { answerPrompt, PromptChanged, PromptGone } from "./answer";
import { watchTranscript } from "./transcript-watch";
import { UploadTooLarge, storeUpload } from "./uploads";
import { OutsideHomeError, collapseHome, listDirectories } from "./dirs";
import { FileTooLarge, readWithinHome } from "./files";
import { RateLimiter, clientAddress, isRateLimitedPath } from "./ratelimit";
import type { Devices, Pairing } from "./pairing";
import type { PaneFrame, Poller } from "./poller";
import type { PushService } from "./push";
import { STATUS_PRIORITY, type SessionState, type SessionStore } from "./state";
import type { TranscriptStore } from "./transcript";

export interface SocketData {
  /** The paired device behind this socket, so revoking it can close it. */
  deviceId: string | null;
  /** Pane this client currently has open, if any. */
  watchedPaneId: string | null;
  releaseWatch: (() => void) | null;
  /** Stops the transcript-file watch that goes with `watchedPaneId`. */
  releaseLog: (() => void) | null;
  /**
   * The session token presented at upgrade. Re-verified on every heartbeat,
   * because a socket outlives the cookie that opened it: a phone left on the
   * dashboard would otherwise keep receiving screens for as long as the
   * connection held, however long ago its session expired.
   */
  token: string | undefined;
}

/**
 * A client of the dashboard stream: a `/ws` socket, or a link through the
 * relay (`relay-client.ts`). Everything here that pushes — session, frame,
 * prompt, status, log_changed, ping — and everything that ends a client (a
 * revoked device, an expired session) goes through this, so a relay link is
 * treated exactly as a socket is rather than by a second copy of the logic.
 * `send` takes the JSON already serialised: one stringify per broadcast,
 * however many clients.
 */
export interface StreamClient {
  readonly data: SocketData;
  send(payload: string): void;
  close(code: number, reason: string): void;
}

/**
 * How a request arrived, for the parts of handling that depend on the
 * transport: what the rate limiter keys on, and whether `/ws` can be upgraded.
 * A relay link has no peer address, so it names its device instead; a request
 * from the port names the address it came from.
 */
export interface Arrival {
  rateKey: string;
  /** Came through the relay: reachable from the internet before any secret is proven. */
  viaRelay: boolean;
  /** Turns the request into a socket carrying `data`; null where that is impossible. */
  upgrade: ((data: SocketData) => boolean) | null;
}

/** What `createServer` returns: the port, and the same handling for clients that did not come through it. */
export interface ShahiServer {
  port: number;
  stop(force?: boolean): void;
  /**
   * Handles a request exactly as the port would — gate, revocation, the 426
   * check, every route — for one that arrived some other way. Uncompressed:
   * the caller owns the bytes from here.
   */
  dispatch(req: Request, rateKey: string): Promise<Response>;
  /** Registers a client of the dashboard stream, as a `/ws` open does. */
  attach(client: StreamClient): void;
  /** Releases everything the client held, as a `/ws` close does. */
  detach(client: StreamClient): void;
  /** A message from the client: `watch` / `unwatch`. */
  receive(client: StreamClient, message: unknown): void;
}

export interface HttpDeps {
  config: Config;
  auth: Auth;
  client: HerdrClient;
  store: SessionStore;
  poller: Poller;
  transcript: TranscriptStore;
  push: PushService;
  pairing: Pairing;
  devices: Devices;
  /** Minted once per installation; see `identity.ts`. */
  serverId: string;
  /** The relay client's state, when there is one — read at request time, since it is created after this server. */
  relay?: () => { url: string; connected: boolean } | null;
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

/**
 * The largest body any route accepts. Uploads are the biggest legitimate
 * request and are capped at 32MB in `uploads.ts` — but that check runs after
 * `req.formData()` has already buffered the whole body, so without this Bun's
 * default (128MB) was the real ceiling on what one request could make the
 * process hold.
 */
const MAX_REQUEST_BODY_BYTES = 40 * 1024 * 1024;

/** A phone mints these as ~20 characters; anything long is not a message id. */
const MAX_CLIENT_MESSAGE_ID = 128;

/** Closing a socket because its session is no longer valid (revoked or expired). */
export const CLOSE_SESSION_EXPIRED = 4001;

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });

/**
 * A JSON body as an object, or an empty one. `req.json()` happily returns
 * `null` or a string for a body that is valid JSON, and every route then read
 * a property off it — a 500 with a stack trace for a body of `null`.
 */
async function jsonObject<T extends object>(req: Request): Promise<Partial<T>> {
  const body: unknown = await req.json().catch(() => null);
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Partial<T>) : {};
}

/**
 * A query parameter as an integer inside `[min, max]`, or `fallback`.
 *
 * `Number(...)` alone let `limit=NaN` and `limit=-1` through, and both made
 * the transcript window start at offset zero — the whole file, parsed, for a
 * request that asked for less than one message.
 */
function intParam(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Whether a request's `Origin` is this server.
 *
 * Browsers attach the cookie to a cross-origin POST or WebSocket upgrade just
 * as readily as to a same-origin one, and `SameSite=Strict` does not help
 * against a page on the same *site* — another machine's `*.tailnet.ts.net`
 * name, say. A `text/plain` POST needs no preflight and `req.json()` never
 * looked at the content type, so a page there could have typed into a pane.
 * The native app's `fetch` sends no `Origin`, which is what a request with
 * none means: not a browser, and the cookie was attached on purpose. Its
 * WebSocket does send one — React Native builds it from the socket URL — so
 * it matches `Host` by construction, except that iOS drops the brackets from
 * an IPv6 literal; hosts are compared with brackets removed for that reason.
 *
 * A reverse proxy in front (`tailscale serve`, `cloudflared`) may rewrite
 * `Host` to this process's address and keep the public name only in
 * `x-forwarded-host`, so either may match. Believing that header is safe
 * here: a browser cannot set it on a WebSocket upgrade at all, and setting it
 * on a fetch forces a preflight this server never answers.
 */
function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    // "http://fd7a:115c::1:7171" — an IPv6 literal with its brackets lost is
    // not a URL, but it is still this server if the rest matches.
    originHost = origin.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  }
  const bare = (h: string) => h.split(",")[0]!.trim().replace(/[[\]]/g, "");
  return [req.headers.get("host"), req.headers.get("x-forwarded-host")].some(
    (host) => host !== null && bare(host) === bare(originHost),
  );
}

export interface ServerOptions {
  /** How often to ping and to re-check every socket's session. */
  heartbeatMs?: number;
}

export function createServer(deps: HttpDeps, { heartbeatMs = HEARTBEAT_MS }: ServerOptions = {}): ShahiServer {
  const { config, auth, client, store, poller, transcript, push, pairing, devices, serverId } = deps;
  const clients = new Set<StreamClient>();

  // The routes that answer before the gate are the only ones anyone can hit.
  const limiter = new RateLimiter();

  /**
   * What a client learns before it authenticates. The versions only on a
   * direct connection: over the relay anyone who knows the serverId can ask,
   * and a box on the internet should not say which Shahi and which herdr it
   * runs (2026-09-02 review, R5). The phone needs `serverId` and `api` only.
   */
  // The relay's state only for a caller on this machine — the plugin's
  // `status` — not for every tailnet peer: with the serverId beside it, a
  // self-hosted relay's address is enough to fill the box's eight phone slots.
  const serverInfo = (arrival: Arrival): ServerInfo => {
    const viaRelay = arrival.viaRelay;
    const relay = !viaRelay && isLoopback(arrival.rateKey) ? deps.relay?.() : null;
    return {
      serverId,
      api: { min: SHAHI_API_VERSION, max: SHAHI_API_VERSION },
      ...(viaRelay
        ? {}
        : { serverVersion: pkg.version, herdr: { version: store.state.version, protocol: store.state.protocol } }),
      ...(relay ? { relay } : {}),
    };
  };

  // Prompts already handed to herdr, by the phone's own message id, so a retry
  // after a timeout gets the receipt back rather than a second delivery.
  const receipts = new PromptReceipts<PromptReceipt>();

  // The untyped view of the client the prompt module takes: it names three
  // methods and a test wants to fake them.
  const herdrRpc = (method: string, params: Record<string, unknown>) =>
    client.rpc(method as Method, params as ParamsFor<Method>);

  /** herdr said no (400, with its code) or something else broke (500). */
  const failure = (err: unknown) =>
    err instanceof HerdrError
      ? json({ error: err.message, code: err.code }, { status: 400 })
      : json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });

  // herdr's own agent-panel preference, cached rather than re-read on every
  // broadcast. Refreshed whenever the dashboard is fetched, so editing
  // config.toml takes effect on the next pull rather than needing a restart.
  let defaultGrouping: string | null = null;
  void readAgentPanelSort().then((value) => {
    defaultGrouping = value;
  });

  const identify = (req: Request) => auth.identify(readCookie(req.headers.get("cookie"), SESSION_COOKIE));

  // A revoked device fails here, on its next request — `Auth` asks `devices`
  // about every device token it sees. A live one is marked seen, so Settings
  // can say which phones are still in use.
  const authorized = (req: Request) => {
    const who = identify(req);
    if (who?.deviceId) devices.touch(who.deviceId);
    return who !== null;
  };

  // One throttle for the whole server: login attempts are serialised and slowed
  // after failures so the small passcode space cannot be brute-forced.
  const loginThrottle = new LoginThrottle();
  // A separate throttle for pairing claims: sharing one with login let a flood
  // of bad claims pin the owner's own login backoff at 30s (pentest L1). Each
  // is a serialized global backoff over its own low-entropy-or-not secret.
  const claimThrottle = new LoginThrottle();

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

    // Never Bun's dev error page: it embeds the source, the absolute
    // `/Users/<name>/…` path and a stack trace, and one trigger (a malformed
    // Host header failing `new URL(req.url)`) is reachable before auth
    // (pentest M1). `development: false` is pinned here rather than left to
    // NODE_ENV, which the service does not set, and the handler is the floor.
    development: false,
    error() {
      return new Response("internal error", { status: 500 });
    },

    // See MAX_REQUEST_BODY_BYTES: the upload limit is only real if the body
    // is refused before it is buffered.
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,

    async fetch(req, srv) {
      const response = await handle(req, {
        rateKey: clientAddress(srv.requestIP(req)?.address ?? null, req.headers.get("x-forwarded-for"), config.host),
        viaRelay: false,
        upgrade: (data) => srv.upgrade(req, { data }),
      });
      // Compression happens here and nowhere else: routes stay unaware of it,
      // and a websocket upgrade (which returns undefined) passes through.
      return response ? harden(await compress(req, response, compressionKey(response))) : response;
    },

    websocket: {
      // Comfortably longer than the heartbeat below, so only a genuinely dead
      // connection is ever closed for idling.
      idleTimeout: 90,

      // The session payload is 18KB of JSON and goes out on every change.
      perMessageDeflate: true,

      open(ws) {
        attach(ws);
      },

      close(ws) {
        detach(ws);
      },

      message(ws, raw) {
        let msg: unknown;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        receive(ws, msg);
      },
    },
  });

  function attach(ws: StreamClient): void {
    clients.add(ws);
    poller.setClientCount(clients.size);
    void dashboard(store, poller, defaultGrouping).then((session) =>
      ws.send(JSON.stringify({ type: "session", session })),
    );
  }

  function detach(ws: StreamClient): void {
    ws.data.releaseWatch?.();
    ws.data.releaseWatch = null;
    ws.data.releaseLog?.();
    ws.data.releaseLog = null;
    clients.delete(ws);
    poller.setClientCount(clients.size);
  }

  function receive(ws: StreamClient, message: unknown): void {
    if (typeof message !== "object" || message === null) return;
    const msg = message as { type?: unknown; paneId?: unknown };

    // Registered even for a pane the mirror has not seen yet: a phone that
    // starts an agent and opens it can arrive before the pane_created event
    // has been applied, and dropping the watch left that screen on the slow
    // interval for good. Only the work that needs the pane (the first read,
    // the transcript) waits for it.
    if (msg.type === "watch" && typeof msg.paneId === "string") {
      watch(ws, msg.paneId);
    } else if (msg.type === "unwatch") {
      ws.data.releaseWatch?.();
      ws.data.releaseWatch = null;
      ws.data.releaseLog?.();
      ws.data.releaseLog = null;
      ws.data.watchedPaneId = null;
    }
  }

  // See the `ping` message in the shared contract: silence has to be
  // distinguishable from a dead connection, and a phone's socket dies quietly.
  //
  // The same tick re-checks every socket's session. The gate runs at upgrade
  // and nowhere else on a socket, so this is what turns a 30-day cookie into
  // a 30-day socket rather than an indefinite one. `verifyToken` is the same
  // check the upgrade made, so a rotated secret and an expired cookie are
  // both caught, and the token's format stays auth's business.
  setInterval(() => {
    for (const ws of clients) {
      if (!auth.verifyToken(ws.data.token)) ws.close(CLOSE_SESSION_EXPIRED, "session expired");
    }
    if (clients.size === 0) return;
    broadcast({ type: "ping", at: Date.now() });
  }, heartbeatMs);


  /**
   * Every request, before compression.
   *
   * Returns undefined for a websocket upgrade, which Bun takes as "already
   * handled".
   */
  async function handle(req: Request, arrival: Arrival): Promise<Response | undefined> {
        const url = new URL(req.url);
        const { pathname } = url;

        // --- unauthenticated ---
        if (isRateLimitedPath(pathname)) {
          const wait = limiter.hit(arrival.rateKey);
          if (wait !== null) {
            return json(
              { error: "too many requests" },
              { status: 429, headers: { "retry-after": String(Math.ceil(wait / 1000)) } },
            );
          }
        }

        // A browser on another origin gets no further than this with the
        // cookie it carries. Reads are left alone: CORS already denies the
        // page the response, and the archived web client's static assets
        // are fetched cross-origin by nothing.
        if ((pathname === "/ws" || (pathname.startsWith("/api/") && req.method !== "GET")) && !originAllowed(req)) {
          return json({ error: "cross-origin request refused" }, { status: 403 });
        }

        if (pathname === "/api/meta") return json(serverInfo(arrival));

        // The contract version rides on every request, so a phone that kept its
        // cookie across a server upgrade learns of a mismatch on the first call
        // rather than from a screen that half-works. Absent means an older
        // client that predates negotiation, or the archived web client, and is
        // let through.
        const claimed = req.headers.get("x-shahi-api");
        if (claimed !== null) {
          const n = Number(claimed);
          if (!Number.isInteger(n) || n < SHAHI_API_VERSION || n > SHAHI_API_VERSION) {
            return json(
              {
                error:
                  n > SHAHI_API_VERSION
                    ? "This server runs an older Shahi than the app. Update Shahi on this computer — run herdr plugin install iYassr/shahi again."
                    : "This app is older than the Shahi on this server. Update the app.",
                api: { min: SHAHI_API_VERSION, max: SHAHI_API_VERSION },
              },
              { status: 426 },
            );
          }
        }

        if (pathname === "/api/auth/status") {
          return json({ required: !auth.disabled, authenticated: authorized(req) });
        }

        if (pathname === "/api/auth/login" && req.method === "POST") {
          const body = await jsonObject<{ passcode: string }>(req);
          // Serialised + backing off: concurrency buys an attacker nothing, and
          // each failure slows the next. See LoginThrottle.
          const ok = await loginThrottle.attempt(() =>
            auth.verifyPasscode(typeof body.passcode === "string" ? body.passcode : ""),
          );
          if (!ok) {
            return json({ error: "invalid passcode" }, { status: 401 });
          }
          return json({ ok: true }, { headers: { "set-cookie": auth.cookie(auth.issue()) } });
        }

        if (pathname === "/api/auth/logout" && req.method === "POST") {
          // A paired phone signing out ends its identity as well as its cookie.
          // Otherwise the row stayed "active" for thirty days and every re-pair
          // added a ghost to the list in Settings.
          const deviceId = identify(req)?.deviceId;
          if (deviceId) devices.revoke(deviceId);
          return json({ ok: true }, { headers: { "set-cookie": Auth.clearCookie() } });
        }

        // A scanned code being redeemed. Through the same throttle as the
        // passcode: a code is 256 bits and unguessable, but this route answers
        // without a session and nothing unauthenticated should be free to hammer.
        // The session it grants is bound to the new device, which is what
        // makes it revocable — a passcode login is not, and never appears in
        // the device list.
        if (pathname === "/api/pair/claim" && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as { secret?: unknown; deviceName?: unknown };
          const secret = typeof body.secret === "string" ? body.secret : "";
          const ok = await claimThrottle.attempt(async () => pairing.claim(secret));
          if (!ok) {
            return json(
              { error: "That pairing code is not valid. A code works once and for ten minutes — print a new one." },
              { status: 401 },
            );
          }
          const { device, secret: deviceSecret } = devices.create(typeof body.deviceName === "string" ? body.deviceName : "");
          // The secret rides in the body, not a cookie: a phone that came in
          // through the relay sees no Set-Cookie (the link keeps its own
          // session), and the secret is what lets it come back as this device.
          const result: ClaimResult & { device: PairedDevice } = {
            ok: true,
            device,
            deviceId: device.id,
            deviceSecret: Buffer.from(deviceSecret).toString("base64url"),
          };
          return json(result, { headers: { "set-cookie": auth.cookie(auth.issue(Date.now(), device.id)) } });
        }

        // --- everything below requires a session ---
        if (pathname.startsWith("/api/") || pathname === "/ws") {
          if (!authorized(req)) return json({ error: "unauthorized" }, { status: 401 });
        }

        if (pathname === "/ws") {
          const upgraded = arrival.upgrade?.({
            deviceId: identify(req)?.deviceId ?? null,
            watchedPaneId: null,
            releaseWatch: null,
            releaseLog: null,
            token: readCookie(req.headers.get("cookie"), SESSION_COOKIE),
          });
          return upgraded ? undefined : new Response("expected a websocket upgrade", { status: 400 });
        }

        // Minting a code needs a session: `server/scripts/pair.ts` signs one
        // for itself from the same SESSION_SECRET, so whoever can read .env on
        // the box — the owner — can pair a phone, and nobody else can.
        if (pathname === "/api/pair" && req.method === "POST") {
          // Only a passcode (or script) session may mint. A paired phone that
          // could mint would hand itself a second identity, and revoking the one
          // the owner can see would leave its sibling with full access until the
          // secret rotates — not what Revoke promises (review finding).
          if (identify(req)?.deviceId) {
            return json({ error: "a paired device cannot mint pairing codes" }, { status: 403 });
          }
          return json(pairing.mint());
        }

        if (pathname === "/api/devices" && req.method === "GET") {
          const list: DeviceList = { devices: devices.list(), thisDeviceId: identify(req)?.deviceId ?? null };
          return json(list);
        }

        // Revoking a phone: its cookie stops working on the next request (the
        // gate above asks `devices`), and its open socket is closed here rather
        // than left streaming the dashboard until it happens to drop.
        const deviceMatch = pathname.match(/^\/api\/devices\/([^/]+)$/);
        if (deviceMatch && req.method === "DELETE") {
          // A malformed %-escape throws out of decodeURIComponent; a 404 is the
          // honest answer, not a 500 with a stack trace (pentest M1).
          let id: string;
          try {
            id = decodeURIComponent(deviceMatch[1]!);
          } catch {
            return json({ error: "no such device" }, { status: 404 });
          }
          if (!devices.revoke(id)) return json({ error: "no such device" }, { status: 404 });
          for (const ws of clients) {
            if (ws.data.deviceId === id) ws.close(4001, "device revoked");
          }
          return json({ ok: true });
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
          const body = await jsonObject<{
            workspaceId: string;
            cwd: string | null;
            label: string | null;
            kind: string;
            name: string;
            mode: string | null;
          }>(req);
          if (typeof body.workspaceId !== "string" || !body.workspaceId || typeof body.kind !== "string" || !body.kind) {
            return json({ error: "workspaceId and kind are required" }, { status: 400 });
          }
          // herdr does not expand `~`; it silently uses $HOME instead, which puts
          // the agent somewhere the user did not ask for.
          if (body.cwd && (typeof body.cwd !== "string" || !body.cwd.startsWith("/"))) {
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

        // A new space. Semantic rather than raw RPC so the phone never learns a
        // herdr method name — the shape herdr wants stays the server's business.
        if (pathname === "/api/workspaces" && req.method === "POST") {
          const body = await jsonObject<{ label: string | null; cwd: string | null }>(req);
          // herdr does not expand `~`; it silently uses $HOME instead.
          if (body.cwd && (typeof body.cwd !== "string" || !body.cwd.startsWith("/"))) {
            return json({ error: "cwd must be an absolute path" }, { status: 400 });
          }
          try {
            const created = await client.rpc("workspace.create", {
              label: body.label ?? null,
              cwd: body.cwd ?? null,
              focus: false,
            });
            return json({ workspaceId: created.workspace.workspace_id });
          } catch (err) {
            return failure(err);
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
          // Quotes and backslashes would end the quoted-string; control
          // characters (a newline is a legal filename on Linux) would end the
          // header, and `Headers` throws on them — a 500 for a file that
          // merely has an odd name.
          const safeName = file.name.replace(/[\x00-\x1f\x7f"\\]/g, "_");
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
          const body = await jsonObject(req);
          if (!push.isSubscription(body)) return json({ error: "malformed subscription" }, { status: 400 });
          push.subscribe(body);
          return json({ ok: true });
        }

        // The native app's channel. No VAPID, no service worker — Expo's push
        // service takes a token and hands the notification to FCM or APNs.
        if (pathname === "/api/push/expo" && req.method === "POST") {
          const body = await jsonObject<{ token: unknown }>(req);
          if (!push.isExpoToken(body.token)) {
            return json({ error: "malformed expo push token" }, { status: 400 });
          }
          push.subscribeExpo(body.token);
          return json({ ok: true });
        }

        if (pathname === "/api/push/expo/unsubscribe" && req.method === "POST") {
          const body = await jsonObject<{ token: unknown }>(req);
          if (typeof body.token === "string") push.unsubscribeExpo(body.token);
          return json({ ok: true });
        }

        if (pathname === "/api/push/test" && req.method === "POST") {
          const sent = await push.sendTest();
          return json({ sent });
        }

        const paneMatch = pathname.match(/^\/api\/panes\/([^/]+)(\/[a-z]+)?$/);
        if (paneMatch) {
          // A malformed escape (`%zz`) throws here, and used to be a 500 with
          // a stack trace for what is simply not a pane.
          let paneId: string;
          try {
            paneId = decodeURIComponent(paneMatch[1]!);
          } catch {
            return json({ error: "no such pane" }, { status: 404 });
          }
          const sub = paneMatch[2];

          if (!store.pane(paneId)) return json({ error: "no such pane" }, { status: 404 });

          // A conversational prompt: one request from the phone, and the choice
          // between herdr's `agent.prompt` and the terminal sequence made here.
          // See `prompt.ts` for why a blocked agent takes the terminal path.
          if (sub === "/prompt" && req.method === "POST") {
            const body = await jsonObject<{ text: string; clientMessageId: string }>(req);
            if (typeof body.text !== "string" || body.text.length === 0) {
              return json({ error: "text is required" }, { status: 400 });
            }
            if (
              typeof body.clientMessageId !== "string" ||
              body.clientMessageId.length === 0 ||
              body.clientMessageId.length > MAX_CLIENT_MESSAGE_ID
            ) {
              return json({ error: "clientMessageId is required" }, { status: 400 });
            }
            // Pane ids contain ':' (`w4:p1`), so the two parts are framed
            // rather than joined — a bare join could make two different
            // (pane, message) pairs the same key.
            const key = JSON.stringify([paneId, body.clientMessageId]);
            const seen = receipts.get(key);
            if (seen) return json(seen);
            const agent = store.agent(paneId);
            try {
              await submitPrompt(
                herdrRpc,
                { paneId, isAgent: agent !== undefined, status: agent?.agent_status ?? null },
                body.text,
              );
            } catch (err) {
              return failure(err);
            }
            const receipt: PromptReceipt = {
              accepted: true,
              clientMessageId: body.clientMessageId,
              acceptedAt: Date.now(),
            };
            receipts.put(key, receipt);
            return json(receipt);
          }

          // One tap on an option card. The server decides the keystrokes —
          // a digit, or cursor moves and Enter — against the screen as it is
          // now, because the phone never learns which menu shape it showed,
          // and its copy of the screen may be seconds old (see `answer.ts`).
          if (sub === "/answer" && req.method === "POST") {
            const body = await jsonObject<{ index: unknown; label: unknown }>(req);
            if (!Number.isInteger(body.index) || typeof body.label !== "string") {
              return json({ error: "index and label are required" }, { status: 400 });
            }
            try {
              await answerPrompt(herdrRpc, paneId, { index: body.index as number, label: body.label });
              return json({ ok: true });
            } catch (err) {
              if (err instanceof PromptGone || err instanceof PromptChanged) {
                return json({ error: err.message, code: err.code }, { status: 409 });
              }
              return failure(err);
            }
          }

          // Key presses: Escape, an arrow, Enter from the key bar. Not a prompt.
          if (sub === "/keys" && req.method === "POST") {
            const body = await jsonObject<{ keys: unknown }>(req);
            const keys = Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === "string") : [];
            if (keys.length === 0) return json({ error: "keys is required" }, { status: 400 });
            try {
              await client.rpc("pane.send_keys", { pane_id: paneId, keys });
              return json({ ok: true });
            } catch (err) {
              return failure(err);
            }
          }

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
            const limit = intParam(url.searchParams.get("limit"), 60, 1, 400);
            const before = url.searchParams.get("before")
              ? intParam(url.searchParams.get("before"), 0, 0, Number.MAX_SAFE_INTEGER)
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
            const limit = intParam(url.searchParams.get("limit"), 500, 1, 2_000);
            const lines = before
              ? transcript.before(paneId, intParam(before, 0, 0, Number.MAX_SAFE_INTEGER), limit)
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

        // Raw RPC, kept for the archived web client, which still speaks it. The
        // native app does not: its writes go through the semantic routes above,
        // so a herdr method rename never reaches a phone. Full control, as
        // chosen — the gate above is the boundary, not an allowlist here.
        //
        // A client that negotiates a contract version is the native app, and
        // the contract says it never calls this — so a request carrying
        // `x-shahi-api` is refused, and a build that regressed into raw RPC
        // fails in development rather than shipping a dependency on herdr's
        // method names. The web client and `curl` send no version header.
        if (pathname === "/api/rpc" && req.method === "POST") {
          if (req.headers.has("x-shahi-api")) {
            return json({ error: "raw RPC is not part of the app contract; use the Shahi routes" }, { status: 403 });
          }
          const body = await jsonObject<{ method: string; params: unknown }>(req);
          if (typeof body.method !== "string" || !body.method) return json({ error: "method is required" }, { status: 400 });
          try {
            const method = body.method as Method;
            const result = await client.rpc(method, (body.params ?? {}) as ParamsFor<Method>, {
              // agent.start and friends block waiting for something to happen;
              // the default ceiling would fail them every time. Own keys only:
              // a method named `constructor` found one on the prototype.
              timeoutMs: Object.hasOwn(SLOW_METHODS, method) ? SLOW_METHODS[method] : undefined,
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

  function watch(ws: StreamClient, paneId: string): void {
    // Releasing before acquiring would drop the watch count to zero and let the
    // pane fall back to the slow interval between two views of the same pane.
    const previous = ws.data.releaseWatch;
    ws.data.releaseWatch = poller.watch(paneId);
    ws.data.watchedPaneId = paneId;
    previous?.();

    const frame = poller.frame(paneId);
    if (frame) ws.send(JSON.stringify({ type: "frame", frame }));
    else if (store.pane(paneId)) void poller.refresh(paneId);

    ws.data.releaseLog?.();
    ws.data.releaseLog = watchLog(ws, paneId);
  }

  /**
   * Watches the pane's transcript file and tells this client when it grows.
   *
   * The reader is fed by the transcript, not the terminal, so this is the
   * signal it actually wants: a reply lands in the file and the phone hears
   * within the debounce window, instead of on its next 2.5s poll. The file may
   * not exist yet for a just-started agent, so resolution is retried on each
   * pushed frame — frames arrive while an agent works, and the first one after
   * it has said something is when the file appears.
   */
  function watchLog(ws: StreamClient, paneId: string): () => void {
    let stopFile: (() => void) | null = null;
    let resolving = false;
    let stopped = false;

    const resolveAndWatch = async () => {
      if (stopped || stopFile || resolving) return;
      resolving = true;
      try {
        const path = await transcriptPathFor(paneId);
        if (stopped || !path) return;
        stopFile = watchTranscript(path, (offset) => {
          if (ws.data.watchedPaneId !== paneId) return;
          ws.send(JSON.stringify({ type: "log_changed", paneId, offset }));
        });
      } catch {
        // Resolution is best-effort; the reader's own poll still covers it.
      } finally {
        resolving = false;
      }
    };

    const onFrame = (frame: PaneFrame) => {
      if (frame.paneId === paneId && !stopFile) void resolveAndWatch();
    };
    poller.on("frame", onFrame);
    void resolveAndWatch();

    return () => {
      stopped = true;
      poller.off("frame", onFrame);
      stopFile?.();
      stopFile = null;
    };
  }

  /** The file the reader for this pane reads, if it has one yet. */
  async function transcriptPathFor(paneId: string): Promise<string | null> {
    const pane = store.pane(paneId);
    if (!pane) return null;
    if (pane.agent === "codex") {
      return findCodexRollout(client, paneId, pane.cwd ?? null, pane.agent_session?.value ?? null);
    }
    const sessionId = pane.agent_session?.value;
    return sessionId ? findTranscript(sessionId) : null;
  }

  return {
    port: server.port ?? config.port,
    stop: (force) => server.stop(force),
    // A relay link cannot become a socket; `/ws` over one is answered 400,
    // which nothing sends — the link *is* the stream.
    dispatch: async (req, rateKey) =>
      (await handle(req, { rateKey, viaRelay: true, upgrade: null })) ?? new Response(null, { status: 400 }),
    attach,
    detach,
    receive,
  };
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
 * Headers every response carries, set once at the edge like compression.
 *
 * `nosniff` is the one that matters: `/api/file` serves agent-written files
 * under a type chosen from the extension, and a browser second-guessing that
 * type is how a `.txt` becomes a page with this origin's cookie. Frames and
 * referrers are refused for the same reason the cookie is `SameSite=Strict`:
 * nothing legitimate embeds this app or needs to know which file was open.
 */
function harden(response: Response): Response {
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("x-frame-options", "DENY");
  response.headers.set("referrer-policy", "same-origin");
  return response;
}

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
    // Vite content-hashes into `assets/name-<hash>.ext`, where the hash is
    // mixed-case base64url (`index-DfotvnE1.js`) — NOT the lowercase-hex,
    // dot-delimited form the old matcher assumed, so it matched nothing and
    // every hashed asset was served no-cache (confirmed on a production
    // request). Require the assets/ prefix (where Vite puts only hashed files)
    // and the dash-hash tail, so nothing unhashed is ever frozen.
    const immutable = /^assets\/.*-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(relative);
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
