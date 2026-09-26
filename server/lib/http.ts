import { conversationSummary, retainSummaries, transcriptPage, transcriptPathFor } from "./conversation-summary";
import { buildId } from "./build";
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
  API_SUPPORT,
  latestConversations,
  type ClaimResult,
  type DashboardPane,
  type DeviceList,
  type PairedDevice,
  type PromptReceipt,
  type ServerInfo,
} from "@shahi/shared";
import { PANE_REPLACED } from "@shahi/shared/errors";
import pkg from "../package.json" with { type: "json" };

export type { DashboardPane };
import { Observability } from "./observability";
import { Auth, LoginThrottle, SESSION_COOKIE, readCookie } from "./auth";
import type { Config } from "./config";
import { HerdrError, SLOW_METHODS, type HerdrClient, type Method, type ParamsFor } from "./herdr-client";
import { AgentStartFailed, forgetInstalledAgents, installedAgents, startAgentInTab } from "./agents";
import { compress } from "./compress";
import { readAgentPanelSort } from "./herdr-config";
import { readSessionImage } from "./session-log";
import { agentSessionOf } from "./herdr-pane";
import { hostname } from "node:os";
import { isLoopback } from "./endpoint";
import { PromptMoved, PromptOpen, promptTarget, submitPrompt } from "./prompt";
import { PaneWrites } from "./pane-writes";
import { OperationError, Operations } from "./operations";
import { trackDelivery } from "./herdr-delivery";
import { createHash } from "node:crypto";
import { answerPrompt, PromptChanged, PromptGone } from "./answer";
import { followTranscript } from "./transcript-watch";
import { UploadTooLarge, storeUpload } from "./uploads";
import { UploadTransfers, TransferError, TRANSFER_CHUNK } from "./upload-transfers";
import { OutsideHomeError, collapseHome, folderProblem, listDirectories } from "./dirs";
import { FileTooLarge, NotAFileError, RangeNotSatisfiable, contentDisposition, parseRange, readWithinHome } from "./files";
import { RateLimiter, clientAddress, isRateLimitedPath } from "./ratelimit";
import type { Devices, Pairing } from "./pairing";
import type { PaneFrame, Poller } from "./poller";
import type { PushService } from "./push";
import { paneTitle, type SessionState, type SessionStore } from "./state";
import type { TranscriptStore } from "./transcript";
import type { ComputerControl } from "./control";

/** Thrown inside a prompt's operation when the pane's program is not the one it was meant for. */
class PaneReplaced extends Error {}

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
  secure?: boolean;
  /** Came through the relay: reachable from the internet before any secret is proven. */
  viaRelay: boolean;
  /** Turns the request into a socket carrying `data`; null where that is impossible. */
  upgrade: ((data: SocketData) => boolean) | null;
  holdOpen?: () => void;
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
  control?: ComputerControl;
  observability?: Observability;
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
/** How long after an answer to look again; see `settleAfterAnswer`. */
const ANSWER_SETTLE_MS = 250;

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

/**
 * The longest message a pane is sent, in UTF-8 bytes. herdr reads a request
 * of at most 1 MiB (`MAX_REQUEST_BYTES`), and JSON can double text full of
 * quotes and backslashes; a quarter of that is about 2,600 lines of a pasted
 * log, and says "too long" before herdr is asked rather than after.
 */
export const MAX_PROMPT_BYTES = 256 * 1024;

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

/**
 * The names a request to the port may give in `Host`: this machine's loopback
 * listener, on any port, since an SSH forward is `127.0.0.1:<its own port>`.
 *
 * `originAllowed` asks only that Origin match Host, and after a DNS rebind a
 * page served from `http://attacker.example:7171` is same-origin with itself:
 * both headers say attacker.example, so it passed, and the page could read
 * `/api/meta` and guess the passcode through the unauthenticated login until
 * it held a session — terminal control (review findings F26/F36). A browser
 * always sends the name it loaded the page from, and a rebinding page is
 * loaded from a name its author controls, never a loopback literal or
 * `localhost`. So the name is checked, not the address it resolved to. Every
 * way in that is meant to reach this port — this machine's own browser, the
 * app's SSH forward, `ssh -L` — names loopback already. A reverse proxy
 * that keeps its public name in `Host` (`tailscale serve` does) is refused
 * unless the owner lists that name in SHAHI_ALLOWED_HOSTS: the documented
 * way to give the local web app HTTPS for push (docs/notifications.md) must
 * keep working, and a rebinding page cannot make the owner's own proxy name
 * resolve to its page. The relay's `dispatch` does not pass through here;
 * nothing a browser chose reaches it.
 */
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;

/** Whether a request's Host names this machine: loopback, or a proxy the owner listed. */
export function addressedHere(host: string, allowed: readonly string[]): boolean {
  // Five digits let `127.0.0.1:99999` through, and Bun builds `req.url` from
  // Host, so `new URL(req.url)` threw before any handler could answer: a bare
  // 500 without the hardening headers, counted nowhere (September 2026
  // pre-release bug hunt). No socket has such a port; nothing sent it here.
  const port = /:(\d{1,5})$/.exec(host)?.[1];
  if (port !== undefined && Number(port) > 65_535) return false;
  return LOOPBACK_HOST.test(host) || viaOwnersProxy(host, allowed);
}

/**
 * Whether a request's Host is a reverse proxy the owner listed in
 * SHAHI_ALLOWED_HOSTS — the only requests whose `x-forwarded-for` a proxy
 * wrote rather than the client (see `clientAddress`).
 */
export function viaOwnersProxy(host: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return false;
  return allowed.includes(host.toLowerCase().replace(/:\d{1,5}$/, ""));
}

/**
 * Requests that present a credential before any session exists, each with its
 * own small admission budget instead of a share of the 32 slots every phone
 * uses.
 *
 * Both wait in a serialised throttle that backs off to 30s, and both used to
 * buffer a body of up to 40MB first. Thirty-two wrong passcodes from any local
 * process held every slot for thirteen minutes, and every phone, the relay
 * included, was told "this box is busy" (review finding F37). Four waiting is
 * more than a person ever has, and a flood of them now costs only the flood.
 */
const CREDENTIAL_ROUTES = new Set(["/api/auth/login", "/api/pair/claim"]);
const MAX_WAITING_CREDENTIALS = 4;
/** A passcode, or a pairing secret and a device name, is well under this. */
const MAX_CREDENTIAL_BODY_BYTES = 4096;
/** The budget every other request shares. */
const MAX_IN_FLIGHT = 32;

/**
 * A request body, or null once it passes `limit` bytes. Read as a stream, so
 * nothing past the limit is ever held.
 */
async function boundedBody(req: Request, limit: number): Promise<Buffer | null> {
  const reader = req.body?.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > limit) {
          await reader.cancel();
          return null;
        }
        parts.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  return Buffer.concat(parts, length);
}

/** `jsonObject` for a body that must be small; null when it is not. */
async function smallJsonObject<T extends object>(req: Request, limit: number): Promise<Partial<T> | null> {
  const bytes = await boundedBody(req, limit);
  if (!bytes) return null;
  let body: unknown = null;
  try {
    body = JSON.parse(bytes.toString("utf8"));
  } catch {
    // Treated as an empty object, as `jsonObject` does.
  }
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Partial<T>) : {};
}

export interface ServerOptions {
  uploadDir?: string;
  /** How often to ping and to re-check every socket's session. */
  heartbeatMs?: number;
}

export function createServer(deps: HttpDeps, { heartbeatMs = HEARTBEAT_MS, uploadDir }: ServerOptions = {}): ShahiServer {
  const { config, auth, client, store, poller, transcript, push, pairing, devices, serverId } = deps;
  const clients = new Set<StreamClient>();
  const metrics = deps.observability ?? new Observability();
  let fileRequests = 0;
  let sharedInFlight = 0;
  // Per route, so a flood of bad passcodes cannot also block pairing a phone.
  const waitingCredentials = new Map<string, number>();

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
      ...(deps.control ? { control: 1 as const } : {}),
      api: { min: API_SUPPORT.min, max: API_SUPPORT.max },
      ...(viaRelay
        ? {}
        : { serverVersion: pkg.version, herdr: { version: store.state.version, protocol: store.state.protocol } }),
      ...(relay ? { relay } : {}),
      ...(!viaRelay && isLoopback(arrival.rateKey) && buildId ? { buildId } : {}),
    };
  };

  // Prompts already handed to herdr, by the phone's own message id, so a retry
  // after a timeout gets the receipt back rather than a second delivery.
  const operations = new Operations();
  // Every write to a pane — a message, an answer, a key — in arrival order,
  // each seeing the screen the one before it left. See `pane-writes.ts`.
  const paneWrites = new PaneWrites();

  // The untyped view of the client the prompt module takes: it names three
  // methods and a test wants to fake them.
  const herdrRpc = (method: string, params: Record<string, unknown>) =>
    client.rpc(method as Method, params as ParamsFor<Method>);

  /**
   * A write carries the occupant it was meant for (`DashboardPane.instanceId`)
   * and is refused when another program holds the pane now. herdr reuses pane
   * ids, and the pre-release bug hunt had a draft's retried send typed into the
   * new shell that took its pane's id: the restarted sidecar had forgotten the
   * first delivery, and nothing asked who was in the pane. Nothing is sent, so
   * the refusal is safe to show as it stands. A client that sends no occupant,
   * an older one, is not checked.
   */
  const replaced = (paneId: string, instanceId: unknown) =>
    typeof instanceId === "string" && instanceId !== store.instance(paneId);
  const replacedResponse = () => json(
    { error: "The conversation this was meant for has ended: another program now runs in that pane, so nothing was sent.", code: PANE_REPLACED },
    { status: 409 },
  );
  const badInstance = (instanceId: unknown) => instanceId !== undefined && typeof instanceId !== "string";

  /** herdr said no (400, with its code) or something else broke (500). */
  const failure = (err: unknown) =>
    err instanceof OperationError
      ? json({ error: err.message }, { status: err.status })
      : err instanceof HerdrError
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
  const transfers = new UploadTransfers(uploadDir);
  let transfersUsed = false;
  const transferSweep = setInterval(() => { if (transfersUsed) void transfers.run(() => transfers.sweep()).catch(() => {}); }, 300_000);
  const pushOwner = (req: Request) => identify(req)?.deviceId ?? `session:${createHash("sha256").update(readCookie(req.headers.get("cookie"), SESSION_COOKIE) ?? "local").digest("hex")}`;
  // A passcode session's registrations end when it does; a device's end when
  // it is revoked, however many sessions it is issued meanwhile.
  const pushExpiry = (req: Request) => {
    const who = identify(req);
    return who && !who.deviceId ? who.expiresAt : null;
  };

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

  /**
   * After an answer, or a refusal because the question had moved on, read
   * the pane and herdr's statuses again shortly, rather than on the next
   * 3-second snapshot. Every other dashboard kept the answered card's options
   * for up to three seconds while herdr already said the agent was working
   * (measured: 33 ms), and a tap on them there was refused (pre-release bug
   * hunt). The pause gives the agent time to repaint.
   */
  const settleAfterAnswer = (paneId: string) => {
    const timer = setTimeout(() => {
      void store.resync();
      void poller.refresh(paneId);
    }, ANSWER_SETTLE_MS);
    timer.unref?.();
  };

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
  const broadcastSession = () => {
    if (sessionBroadcastTimer) return;
    sessionBroadcastTimer = setTimeout(() => {
      sessionBroadcastTimer = undefined;
      if (clients.size > 0) {
        void dashboard(store, poller, defaultGrouping, client).then((session) =>
          broadcast({ type: "session", session }),
        );
      }
    }, SESSION_BROADCAST_INTERVAL_MS);
  };
  store.on("changed", broadcastSession);

  // Transcript writes need not change herdr metadata. Refresh summaries while
  // clients are connected, but send nothing when message metadata is unchanged.
  let readingSummaries = false;
  let summarySignature = "";
  const conversationRefresh = setInterval(async () => {
    if (!clients.size || readingSummaries) return;
    readingSummaries = true;
    try {
      const session = await dashboard(store, poller, defaultGrouping, client);
      const signature = JSON.stringify(session.panes.map(p => [p.paneId, p.lastMessageAt, p.preview]));
      if (signature !== summarySignature) {
        summarySignature = signature;
        broadcast({ type: "session", session });
      }
    } catch { /* The next tick retries without exposing transcript content. */ }
    finally { readingSummaries = false; }
  }, 3000);

  // Transcript lookups to wake when their pane draws a frame (`watchLog`).
  // Woken from the one listener below rather than a listener each: a poller
  // listener per watching client put the ninth watcher past Node's default
  // limit of ten, and the service log printed a false "Possible EventEmitter
  // memory leak" warning (pre-release bug hunt, September 2026).
  const logWakers = new Map<string, Set<() => void>>();

  // Frames go only to clients watching that pane. A screen is ~3.5KB and there
  // are 27 of them; broadcasting all of it would swamp a phone on cellular.
  poller.on("frame", (frame: PaneFrame) => {
    const payload = JSON.stringify({ type: "frame", frame });
    for (const ws of clients) {
      if (ws.data.watchedPaneId === frame.paneId) ws.send(payload);
    }
    for (const wake of logWakers.get(frame.paneId) ?? []) wake();
  });

  // A prompt appearing is worth telling every client about, watching or not:
  // it is what turns a dashboard card into something actionable.
  //
  // So is one disappearing. Only the pane's watchers see that frame, and the
  // mirror's signature has no prompts in it, so while herdr still said
  // "blocked" every other dashboard kept offering options for a menu that was
  // gone — answered at the laptop, or closed by the agent (pre-release bug
  // hunt). A snapshot carries each pane's current prompt, null included.
  const prompted = new Set<string>();
  poller.on("frame", (frame: PaneFrame) => {
    if (frame.prompt) {
      prompted.add(frame.paneId);
      broadcast({ type: "prompt", paneId: frame.paneId, prompt: frame.prompt });
    } else if (prompted.delete(frame.paneId)) broadcastSession();
  });

  store.on("status", (change) => {
    broadcast({ type: "status", change });
    void push.notifyStatusChange(change, store);
  });

  const server = Bun.serve<SocketData, never>({
    hostname: config.host,
    port: config.port,
    // Bun 1.4's types document false as the default, and on macOS it is not:
    // measured, a second Bun listener on a taken port bound anyway and took
    // the connections from the first, so another user's Shahi or a
    // development checkout on this port silently replaced this one, with no
    // EADDRINUSE to say so (pre-release bug hunt). A port that is taken must
    // fail startup.
    reusePort: false,

    // Never Bun's dev error page: it embeds the source, the absolute
    // `/Users/<name>/…` path and a stack trace, and one trigger (a malformed
    // Host header failing `new URL(req.url)`) is reachable before auth
    // (pentest M1). `development: false` is pinned here rather than left to
    // NODE_ENV, which the service does not set, and the handler is the floor.
    development: false,
    // Hardened like every other answer: this is the one that escapes the
    // edge where `harden` is applied.
    error() {
      return harden(new Response("internal error", { status: 500 }));
    },

    // See MAX_REQUEST_BODY_BYTES: the upload limit is only real if the body
    // is refused before it is buffered.
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,

    async fetch(req, srv) {
      // Before anything else, including the in-flight budget: see LOOPBACK_HOST.
      if (!addressedHere(req.headers.get("host") ?? "", config.allowedHosts ?? [])) {
        void req.body?.cancel().catch(() => {});
        return harden(json(
          { error: "Shahi answers only at 127.0.0.1 or localhost. Connect through the relay or an SSH tunnel, or list your own reverse proxy's host name in SHAHI_ALLOWED_HOSTS." },
          { status: 403 },
        ));
      }
      const response = await measuredHandle(req, {
        rateKey: clientAddress(
          srv.requestIP(req)?.address ?? null,
          req.headers.get("x-forwarded-for"),
          viaOwnersProxy(req.headers.get("host") ?? "", config.allowedHosts ?? []),
        ),
        viaRelay: false,
        secure: new URL(req.url).protocol === "https:" ||
          (isLoopback(srv.requestIP(req)?.address ?? "") && req.headers.get("x-forwarded-proto") === "https"),
        upgrade: (data) => srv.upgrade(req, { data }),
        holdOpen: () => srv.timeout(req, 0),
      });
      // Compression happens here and nowhere else: routes stay unaware of it,
      // and a websocket upgrade (which returns undefined) passes through.
      return response ? harden(await compress(req, response, compressionKey(response)), new URL(req.url).pathname) : response;
    },

    websocket: {
      // Comfortably longer than the heartbeat below, so only a genuinely dead
      // connection is ever closed for idling.
      idleTimeout: 90,

      // The session payload is 18KB of JSON and goes out on every change.
      perMessageDeflate: true,
      backpressureLimit: 2 * 1024 * 1024,
      closeOnBackpressureLimit: true,
      maxPayloadLength: 1024 * 1024,

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
    void dashboard(store, poller, defaultGrouping, client).then((session) => {
      ws.send(JSON.stringify({ type: "session", session }));
      // Each waiting pane's prompt again, as the message clients already
      // obey. Apps shipped before the snapshot's prompt was trusted keep the
      // last one pushed while they were connected, so a phone that slept
      // through a new question offered the old one's options, refused with
      // 409, until it was reloaded (pre-release bug hunt).
      for (const pane of session.panes) {
        if (pane.status === "blocked" && pane.prompt) ws.send(JSON.stringify({ type: "prompt", paneId: pane.paneId, prompt: pane.prompt }));
      }
    });
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
  const heartbeat = setInterval(() => {
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
  async function measuredHandle(req: Request, arrival: Arrival): Promise<Response | undefined> {
    const started = performance.now();
    const path = new URL(req.url).pathname;
    const fileWork = path === "/api/uploads" || path.startsWith("/api/uploads/") || path === "/api/file";
    const credential = req.method === "POST" && CREDENTIAL_ROUTES.has(path) ? path : null;
    let status = 500;
    if (credential && (waitingCredentials.get(credential) ?? 0) >= MAX_WAITING_CREDENTIALS) {
      void req.body?.cancel().catch(() => {});
      metrics.request(req, arrival.viaRelay ? "relay" : "http", 429, performance.now() - started);
      return json({ error: "Too many sign-in attempts are waiting. Try again shortly." }, { status: 429, headers: { "retry-after": "30" } });
    }
    if (!credential && (sharedInFlight >= MAX_IN_FLIGHT || (fileWork && fileRequests >= 2))) {
      void req.body?.cancel().catch(() => {});
      metrics.request(req, arrival.viaRelay ? "relay" : "http", 503, performance.now() - started);
      return json({ error: "this box is busy; try again shortly" }, { status: 503, headers: { "retry-after": "2" } });
    }
    // The gauge counts everything in flight; only the budgets are separate.
    metrics.inFlight++;
    if (credential) waitingCredentials.set(credential, (waitingCredentials.get(credential) ?? 0) + 1);
    else sharedInFlight++;
    if (fileWork) fileRequests++;
    try {
      const response = await handle(req, arrival);
      status = response?.status ?? 101;
      return response;
    } catch {
      return json({ error: "internal error" }, { status: 500 });
    } finally {
      metrics.inFlight--;
      if (credential) waitingCredentials.set(credential, waitingCredentials.get(credential)! - 1);
      else sharedInFlight--;
      if (fileWork) fileRequests--;
      metrics.request(req, arrival.viaRelay ? "relay" : "http", status, performance.now() - started);
    }
  }

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

        // Recovery v1 is authenticated before app API negotiation. A paired
        // older/newer app may repair this service without losing its identity.
        if (pathname.startsWith("/api/control/")) {
          if (!authorized(req)) return json({ error: "unauthorized" }, { status: 401 });
          if (req.headers.get("x-shahi-control") !== "1") return json({ error: "Update the app to use this recovery protocol." }, { status: 426 });
          if (!deps.control) return json({ error: "Computer updates are unavailable." }, { status: 404 });
          if (pathname === "/api/control/handshake" && req.method === "GET") return json(deps.control.handshake(), { headers: { "cache-control": "no-store" } });
          if (pathname === "/api/control/update" && req.method === "POST") {
            try {
              const body = await jsonObject(req);
              // Reading a body yields; revocation must win before a durable
              // update request is published to the manager.
              if (!authorized(req)) return json({ error: "unauthorized" }, { status: 401 });
              deps.control.request(body);
              return json({ accepted: true }, { status: 202 });
            }
            catch (e) { return json({ error: e instanceof Error ? e.message : "Cannot start update." }, { status: 409 }); }
          }
          return json({ error: "Unknown recovery action." }, { status: 404 });
        }

        // The contract version rides on every request, so a phone that kept its
        // cookie across a server upgrade learns of a mismatch on the first call
        // rather than from a screen that half-works. Absent means an older
        // client that predates negotiation, or the archived web client, and is
        // let through.
        const claimed = req.headers.get("x-shahi-api");
        const authRoute = pathname.startsWith("/api/auth/") || pathname === "/api/pair/claim";
        if (claimed !== null && !authRoute) {
          const n = Number(claimed);
          if (!Number.isInteger(n) || n < API_SUPPORT.min || n > API_SUPPORT.max) {
            return json(
              {
                error:
                  n > API_SUPPORT.max
                    ? "This server runs an older Shahi than the app. Update Shahi on this computer — run herdr plugin install iYassr/shahi again."
                    : "This app is older than the Shahi on this server. Update the app.",
                api: { min: API_SUPPORT.min, max: API_SUPPORT.max },
              },
              { status: 426 },
            );
          }
        }

        if (pathname === "/api/auth/status") {
          return json({ required: true, authenticated: authorized(req) });
        }

        if (pathname === "/api/auth/login" && req.method === "POST") {
          const body = await smallJsonObject<{ passcode: string }>(req, MAX_CREDENTIAL_BODY_BYTES);
          if (!body) return json({ error: "request too large" }, { status: 413 });
          // Serialised + backing off: concurrency buys an attacker nothing, and
          // each failure slows the next. See LoginThrottle.
          const ok = await loginThrottle.attempt(() =>
            auth.verifyPasscode(typeof body.passcode === "string" ? body.passcode : ""),
          );
          if (!ok) {
            return json({ error: "invalid passcode" }, { status: 401 });
          }
          return json({ ok: true }, { headers: { "set-cookie": auth.cookie(auth.issue(), arrival.secure) } });
        }

        if (pathname === "/api/auth/logout" && req.method === "POST") {
          // A paired phone signing out ends its identity as well as its cookie.
          // Otherwise the row stayed "active" for thirty days and every re-pair
          // added a ghost to the list in Settings.
          const deviceId = identify(req)?.deviceId;
          const token = readCookie(req.headers.get("cookie"), SESSION_COOKIE);
          // Named before anything is revoked: afterwards the cookie no longer
          // says whose it was.
          const owner = pushOwner(req);
          push.unsubscribeOwner(owner);
          if (auth.revoke(token)) {
            for (const ws of clients) if (ws.data.token === token) ws.close(4001, "signed out");
          }
          if (deviceId) {
            devices.revoke(deviceId);
            for (const ws of clients) if (ws.data.deviceId === deviceId) ws.close(4001, "signed out");
          }
          // Nobody can come back for an unfinished upload after this; see `discardOwner`.
          await transfers.run(() => transfers.discardOwner(owner)).catch(() => {});
          return json({ ok: true }, { headers: { "set-cookie": Auth.clearCookie(arrival.secure) } });
        }

        // A scanned code being redeemed. Through the same throttle as the
        // passcode: a code is 256 bits and unguessable, but this route answers
        // without a session and nothing unauthenticated should be free to hammer.
        // The session it grants is bound to the new device, which is what
        // makes it revocable — a passcode login is not, and never appears in
        // the device list.
        if (pathname === "/api/pair/claim" && req.method === "POST") {
          const body = await smallJsonObject<{ secret: string; deviceName: string }>(req, MAX_CREDENTIAL_BODY_BYTES);
          if (!body) return json({ error: "request too large" }, { status: 413 });
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
          return json(result, { headers: { "set-cookie": auth.cookie(auth.issue(Date.now(), device.id), arrival.secure) } });
        }

        // --- everything below requires a session ---
        if (pathname.startsWith("/api/") || pathname === "/ws") {
          if (!authorized(req)) return json({ error: "unauthorized" }, { status: 401 });
        }

        if (pathname === "/api/diagnostics" && req.method === "GET") {
          return json({ ...metrics.snapshot(), relayConnected: deps.relay?.()?.connected ?? null }, { headers: { "cache-control": "no-store" } });
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
          push.unsubscribeOwner(id);
          for (const ws of clients) {
            if (ws.data.deviceId === id) ws.close(4001, "device revoked");
          }
          // A revoked phone can neither finish nor cancel what it was uploading.
          await transfers.run(() => transfers.discardOwner(id)).catch(() => {});
          return json({ ok: true });
        }

        if (pathname === "/api/session") {
          const backend = deps.control?.handshake().backend;
          if (backend && backend.state !== "connected") return json({ error: backend.message, code: "backend_unavailable" }, { status: 503 });
          defaultGrouping = await readAgentPanelSort();
          return json(await dashboard(store, poller, defaultGrouping, client));
        }

        // Choosing where a new space lives. Browsable, because typing a path on a
        // phone keyboard is its own small punishment.
        if (pathname.startsWith("/api/")) {
          const backend = deps.control?.handshake().backend;
          if (backend && backend.state !== "connected") return json({ error: backend.message, code: "backend_unavailable" }, { status: 503 });
        }

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
            clientRequestId: string;
            workspaceId: string;
            /** The space's name as the client showed it; optional, see below. */
            workspaceLabel?: unknown;
            cwd: string | null;
            label: string | null;
            kind: string;
            name: string;
            mode: string | null;
          }>(req);
          // Revocation can happen while a slow request body is still arriving.
          if (!authorized(req)) return json({ error: "unauthorized" }, { status: 401 });
          if (typeof body.workspaceId !== "string" || !body.workspaceId || typeof body.kind !== "string" || !body.kind) {
            return json({ error: "workspaceId and kind are required" }, { status: 400 });
          }
          // herdr gives the highest workspace id to the next space after a
          // restart, and the retry record does not survive one, so an
          // uncertain start retried across a restart made its tab in whichever
          // space held the id by then, with the old space's folder (pre-release
          // bug hunt, B43). A space that is gone is refused, and one whose name
          // is not the name the client showed is taken to be another space.
          const workspace = store.workspace(body.workspaceId);
          if (!workspace) return json({ error: "That space is no longer open on this computer." }, { status: 404 });
          if (body.workspaceLabel !== undefined && body.workspaceLabel !== workspace.label) {
            return json({
              error: "That space was closed on this computer, and another has taken its place. Choose the space again.",
              code: "workspace_changed",
            }, { status: 409 });
          }
          // herdr silently uses $HOME for `~` and for a folder that is not
          // there, which puts the agent somewhere the user did not ask for.
          // Refused before the operation is recorded, so a retry can go ahead.
          const startProblem = await folderProblem(body.cwd);
          if (startProblem) return json({ error: startProblem }, { status: 400 });
          if (typeof body.clientRequestId !== "string" || !body.clientRequestId || body.clientRequestId.length > 128) {
            return json({ error: "clientRequestId is required" }, { status: 400 });
          }
          try {
            // A kind herdr has no manifest for fails only after a tab has been
            // made for it, so it is refused before (pre-release bug hunt, B81).
            const { manifests } = await client.rpc("server.agent_manifests", {});
            if (!manifests.some((manifest) => manifest.agent === body.kind)) {
              return json({ error: `herdr on this computer does not know how to start “${body.kind}”.` }, { status: 400 });
            }
          } catch (err) {
            return failure(err);
          }
          try {
            arrival.holdOpen?.();
            const delivery = trackDelivery((method: string, params: unknown, options?: { timeoutMs?: number }) =>
              client.rpc(method as Method, params as ParamsFor<Method>, options));
            // A start that certainly failed has closed its tab, so a retry
            // under the same id may run again rather than replay the failure.
            let undone = false;
            const started = await operations.run(`start:${body.clientRequestId}`, body, () => startAgentInTab(
              delivery.rpc as never,
              {
                workspaceId: body.workspaceId!,
                cwd: body.cwd ?? null,
                label: body.label ?? null,
                kind: body.kind!,
                name: body.name ?? body.kind!,
                // Forwarded, not implied: this was dropped here for months and
                // every agent silently started with default permissions — found
                // by ps on a live box showing bare `claude` after "Plan first"
                // was chosen. The picker was decorative without this line.
                mode: body.mode ?? null,
              },
            ).catch((err: unknown) => {
              if (err instanceof AgentStartFailed) undone = true;
              throw err;
            }), () => undone || delivery.reachedNothing());
            // The client opens this pane immediately. Event delivery and the
            // periodic mirror can lag behind a successful herdr creation.
            await store.resyncAfterMutation();
            return json(started);
          } catch (err) {
            return failure(err);
          }
        }

        const tabsMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/tabs$/);
        if (tabsMatch && req.method === "POST") {
          let workspaceId: string;
          try { workspaceId = decodeURIComponent(tabsMatch[1]!); }
          catch { return json({ error: "no such workspace" }, { status: 404 }); }
          if (!store.workspace(workspaceId)) return json({ error: "no such workspace" }, { status: 404 });
          const body = await jsonObject<{ label: string | null; cwd: string | null }>(req);
          // Revocation can happen while a slow request body is still arriving.
          if (!authorized(req)) return json({ error: "unauthorized" }, { status: 401 });
          const tabProblem = await folderProblem(body.cwd);
          if (tabProblem) return json({ error: tabProblem }, { status: 400 });
          try {
            const result = await client.rpc("tab.create", {
              workspace_id: workspaceId, label: body.label ?? null, cwd: body.cwd ?? null, focus: false,
            });
            await store.resyncAfterMutation();
            return json({ tabId: result.tab.tab_id, paneId: result.root_pane?.pane_id ?? null });
          } catch (err) { return failure(err); }
        }

        // A new space. Semantic rather than raw RPC so the phone never learns a
        // herdr method name — the shape herdr wants stays the server's business.
        if (pathname === "/api/workspaces" && req.method === "POST") {
          const body = await jsonObject<{ label: string | null; cwd: string | null }>(req);
          // Revocation can happen while a slow request body is still arriving.
          if (!authorized(req)) return json({ error: "unauthorized" }, { status: 401 });
          // herdr silently uses $HOME for `~` and for a folder that is not there.
          const spaceProblem = await folderProblem(body.cwd);
          if (spaceProblem) return json({ error: spaceProblem }, { status: 400 });
          try {
            const created = await client.rpc("workspace.create", {
              label: body.label ?? null,
              cwd: body.cwd ?? null,
              focus: false,
            });
            await store.resyncAfterMutation();
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
          const file = await readWithinHome({ path, download, range: parseRange(req.headers.get("range")) });
          if (req.headers.get("x-shahi-file-version") && req.headers.get("x-shahi-file-version") !== file.version) return json({ error: "The file changed while downloading. Try again." }, { status: 409 });
          return new Response(file.bytes, {
            status: file.range ? 206 : 200,
            headers: {
              "content-type": file.contentType,
              "accept-ranges": "bytes",
              "x-shahi-file-version": file.version,
              ...(file.range ? { "content-range": `bytes ${file.range.start}-${file.range.end}/${file.total}` } : {}),
              "content-length": String(file.bytes.byteLength),
              "content-disposition": contentDisposition(download ? "attachment" : "inline", file.name),
              // The agent may rewrite it a second later.
              "cache-control": "no-store",
            },
          });
        } catch (err: unknown) {
          // Each refusal carries a code as well as words a person can read:
          // the web viewer shows `error` as it stands, and a client can tell
          // the refusals apart without parsing it.
          if (err instanceof RangeNotSatisfiable) {
            return json({ error: err.message, code: "range_not_satisfiable" }, { status: 416, headers: { "content-range": `bytes */${err.size}` } });
          }
          if (err instanceof FileTooLarge) return json({ error: err.message, code: "file_too_large" }, { status: 413 });
          if (err instanceof NotAFileError) return json({ error: err.message, code: "not_a_file" }, { status: 400 });
          if (err instanceof OutsideHomeError) {
            return json({ error: "That file is outside your home folder, so Shahi will not open it.", code: "outside_roots" }, { status: 403 });
          }
          if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") {
            return json({ error: "That file is not there any more. It may have moved or been deleted.", code: "not_found" }, { status: 404 });
          }
          return json({ error: "cannot read that file" }, { status: 404 });
        }
      }

      // A file sent from the phone. It lands in an owned directory and comes
        // back as an absolute path, which is all the agent needs — the same shape
        // as picking something already on the server.
        if (pathname === "/api/uploads/limits" && req.method === "GET") {
          return json({ version: 1, maxBytes: 32 * 1024 * 1024, chunkBytes: TRANSFER_CHUNK });
        }
        const transferMatch = pathname.match(/^\/api\/uploads\/transfers\/([a-zA-Z0-9_-]{16,64})(?:\/(chunk|finish))?$/);
        if (transferMatch) {
          const [, id, action] = transferMatch;
          const owner = pushOwner(req);
          try {
            const bytes = await boundedBody(req, action === "chunk" ? TRANSFER_CHUNK : 2048);
            if (!bytes) throw new TransferError(413, "Upload request too large");
            return await transfers.run(async () => {
              if (!authorized(req) || pushOwner(req) !== owner) return json({ error: "unauthorized" }, { status: 401 });
              transfersUsed = true;
              if (!action && req.method === "GET") return json(await transfers.status(id!, owner));
              if (!action && req.method === "DELETE") return json(await transfers.cancel(id!, owner));
              if (!action && req.method === "PUT") {
                let body; try { body = JSON.parse(bytes.toString()); } catch { throw new TransferError(400, "Invalid file details"); }
                if (!body || typeof body !== "object") throw new TransferError(400, "Invalid file details");
                return json(await transfers.begin(id!, owner, body));
              }
              if (action === "chunk" && req.method === "PUT") {
                const offset = req.headers.get("x-upload-offset");
                if (!offset || !/^\d+$/.test(offset)) throw new TransferError(400, "Invalid offset");
                return json(await transfers.chunk(id!, owner, Number(offset), bytes));
              }
              if (action === "finish" && req.method === "POST") {
                let body; try { body = JSON.parse(bytes.toString()); } catch { throw new TransferError(400, "Invalid file digest"); }
                if (typeof body?.digest !== "string") throw new TransferError(400, "Invalid file digest");
                return json(await transfers.finish(id!, owner, body.digest));
              }
              return json({ error: "Method not allowed" }, { status: 405 });
            });
          } catch (err) {
            return json({ error: err instanceof TransferError ? err.message : "Could not save the file. Check the computer's free space and try again." }, { status: err instanceof TransferError ? err.status : 500 });
          }
        }
        if (pathname === "/api/uploads" && req.method === "POST") {
          const form = await req.formData().catch(() => null);
          // Revocation can happen while a slow request body is still arriving;
          // up to 40MB over SSH is a long time (review finding F92).
          if (!authorized(req)) return json({ error: "unauthorized" }, { status: 401 });
          const file = form?.get("file");
          if (!(file instanceof File)) return json({ error: "no file supplied" }, { status: 400 });
          try {
            // The same directory the chunked route uses, so a test's server
            // never writes into the owner's real uploads.
            return json(await storeUpload(file, undefined, uploadDir));
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
          // Revocation can happen while a slow request body is still arriving.
          if (!authorized(req)) return json({ error: "unauthorized" }, { status: 401 });
          if (!push.isSubscription(body)) return json({ error: "malformed subscription" }, { status: 400 });
          push.subscribe(body, pushOwner(req), pushExpiry(req));
          return json({ ok: true });
        }

        if (pathname === "/api/push/unsubscribe" && req.method === "POST") {
          const body = await jsonObject<{ endpoint: unknown }>(req);
          // Revocation can happen while a slow request body is still arriving.
          if (!authorized(req)) return json({ error: "unauthorized" }, { status: 401 });
          if (typeof body.endpoint !== "string") return json({ error: "endpoint is required" }, { status: 400 });
          push.unsubscribe(body.endpoint, pushOwner(req));
          return json({ ok: true });
        }

        // The native app's channel. No VAPID, no service worker — Expo's push
        // service takes a token and hands the notification to FCM or APNs.
        if (pathname === "/api/push/expo" && req.method === "POST") {
          const body = await jsonObject<{ token: unknown }>(req);
          // Revocation can happen while a slow request body is still arriving.
          if (!authorized(req)) return json({ error: "unauthorized" }, { status: 401 });
          if (!push.isExpoToken(body.token)) {
            return json({ error: "malformed expo push token" }, { status: 400 });
          }
          push.subscribeExpo(body.token, pushOwner(req), pushExpiry(req));
          return json({ ok: true });
        }

        if (pathname === "/api/push/expo/unsubscribe" && req.method === "POST") {
          const body = await jsonObject<{ token: unknown }>(req);
          // Revocation can happen while a slow request body is still arriving.
          if (!authorized(req)) return json({ error: "unauthorized" }, { status: 401 });
          if (typeof body.token === "string") push.unsubscribeExpo(body.token, pushOwner(req));
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
            const body = await jsonObject<{ text: string; clientMessageId: string; instanceId: unknown }>(req);
          // Revocation can happen while a slow request body is still arriving.
          if (!authorized(req)) return json({ error: "unauthorized" }, { status: 401 });
            if (typeof body.text !== "string" || body.text.length === 0) {
              return json({ error: "text is required" }, { status: 400 });
            }
            if (Buffer.byteLength(body.text) > MAX_PROMPT_BYTES) {
              return json({ error: `This message is too long to send: the limit is ${MAX_PROMPT_BYTES / 1024} KB.` }, { status: 413 });
            }
            if (
              typeof body.clientMessageId !== "string" ||
              body.clientMessageId.length === 0 ||
              body.clientMessageId.length > MAX_CLIENT_MESSAGE_ID
            ) {
              return json({ error: "clientMessageId is required" }, { status: 400 });
            }
            if (badInstance(body.instanceId)) return json({ error: "instanceId must be text" }, { status: 400 });
            // Pane ids contain ':' (`w4:p1`), so the two parts are framed
            // rather than joined — a bare join could make two different
            // (pane, message) pairs the same key.
            const key = JSON.stringify([paneId, body.clientMessageId]);
            try {
              const delivery = trackDelivery(herdrRpc);
              const receipt = await operations.run(key, body.text, () => paneWrites.run(paneId, async (): Promise<PromptReceipt> => {
                // Inside the operation, so a retry of a message delivered before
                // the pane changed hands gets its receipt, not a refusal; and
                // a refusal reached nothing, so it is not kept.
                if (replaced(paneId, body.instanceId)) throw new PaneReplaced();
                const target = await promptTarget(delivery.rpc, paneId, store.agent(paneId));
                await submitPrompt(delivery.rpc, target, body.text!);
                return { accepted: true, clientMessageId: body.clientMessageId!, acceptedAt: Date.now() };
              }), delivery.reachedNothing);
              return json(receipt);
            } catch (err) {
              // Nothing was typed: a menu is open and Enter would pick for the
              // person (see `prompt.ts`). The message says what to use instead,
              // so every client, old ones included, shows it as it stands.
              if (err instanceof PromptOpen) return json({ error: err.message, code: err.code }, { status: 409 });
              // Typed, but the screen moved under it before Enter; the message
              // says so, and a retry under this id is handed the same answer.
              if (err instanceof PromptMoved) return json({ error: err.message, code: err.code }, { status: 409 });
              if (err instanceof PaneReplaced) return replacedResponse();
              return failure(err);
            }
          }

          // One tap on an option card. The server decides the keystrokes —
          // a digit, or cursor moves and Enter — against the screen as it is
          // now, because the phone never learns which menu shape it showed,
          // and its copy of the screen may be seconds old (see `answer.ts`).
          if (sub === "/answer" && req.method === "POST") {
            const body = await jsonObject<{ index: unknown; label: unknown; question?: unknown; context?: unknown; promptId?: unknown; instanceId?: unknown }>(req);
          // Revocation can happen while a slow request body is still arriving.
          if (!authorized(req)) return json({ error: "unauthorized" }, { status: 401 });
            if (!Number.isInteger(body.index) || typeof body.label !== "string") {
              return json({ error: "index and label are required" }, { status: 400 });
            }
            // The question and context the card showed. Optional, because a
            // client from before they were sent must still be answered.
            if (
              (body.question !== undefined && typeof body.question !== "string") ||
              (body.context !== undefined &&
                !(Array.isArray(body.context) && body.context.every((line) => typeof line === "string")))
            ) {
              return json({ error: "question must be text and context a list of text" }, { status: 400 });
            }
            // Which appearance of the prompt the card was drawn from, when the
            // server that drew it said (see `ParsedPrompt.promptId`).
            if (body.promptId !== undefined && (typeof body.promptId !== "string" || body.promptId.length > 64)) {
              return json({ error: "promptId must be the id the prompt was sent with" }, { status: 400 });
            }
            if (badInstance(body.instanceId)) return json({ error: "instanceId must be text" }, { status: 400 });
            if (replaced(paneId, body.instanceId)) return replacedResponse();
            try {
              await paneWrites.run(paneId, () => answerPrompt(herdrRpc, paneId, {
                index: body.index as number,
                label: body.label as string,
                ...(typeof body.question === "string" ? { question: body.question } : {}),
                ...(Array.isArray(body.context) ? { context: body.context as string[] } : {}),
                ...(typeof body.promptId === "string" ? { promptId: body.promptId } : {}),
              }, { instances: poller.prompts }));
              // What the agent drew next, to watchers and as a new card to
              // every client, now rather than at the next poll; and herdr's
              // statuses a moment later (see `settleAfterAnswer`).
              void poller.refresh(paneId);
              settleAfterAnswer(paneId);
              return json({ ok: true });
            } catch (err) {
              if (err instanceof PromptGone || err instanceof PromptChanged) {
                settleAfterAnswer(paneId);
                return json({ error: err.message, code: err.code }, { status: 409 });
              }
              return failure(err);
            }
          }

          // Key presses: Escape, an arrow, Enter from the key bar. Not a prompt.
          if (sub === "/keys" && req.method === "POST") {
            const body = await jsonObject<{ keys: unknown; instanceId?: unknown }>(req);
          // Revocation can happen while a slow request body is still arriving.
          if (!authorized(req)) return json({ error: "unauthorized" }, { status: 401 });
            const keys = Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === "string") : [];
            if (keys.length === 0) return json({ error: "keys is required" }, { status: 400 });
            if (badInstance(body.instanceId)) return json({ error: "instanceId must be text" }, { status: 400 });
            if (replaced(paneId, body.instanceId)) return replacedResponse();
            try {
              await paneWrites.run(paneId, () => client.rpc("pane.send_keys", { pane_id: paneId, keys }));
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
            const sessionId = agentSessionOf(store.pane(paneId));
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

            // Each agent keeps its transcript its own way; `transcriptPage`
            // reads it by kind, and not at all while the file is unchanged.
            const path = pane ? await transcriptPathFor(pane, client) : null;
            const page = path ? await transcriptPage(paneId, path, pane!.agent, { limit, before }) : null;

            if (!page) {
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
             * transcript can be assembled from more than one place. It was
             * computed when the page was read, so an unchanged transcript is
             * answered here without being read again.
             */
            if (req.headers.get("if-none-match") === page.etag) {
              return new Response(null, {
                status: 304,
                headers: { etag: page.etag, "cache-control": "no-cache" },
              });
            }
            return json(page.log, { headers: { etag: page.etag, "cache-control": "no-cache" } });
          }

          if (sub === "/transcript") {
            // Rows another program left under this pane id are not its history.
            const instance = store.instance(paneId);
            if (instance) transcript.claim(paneId, instance);
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
              // Additive, as on `DashboardPane`: a pane opened before the list
              // has loaded can still name its occupant.
              instanceId: store.instance(paneId),
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
          // Revocation can happen while a slow request body is still arriving.
          if (!authorized(req)) return json({ error: "unauthorized" }, { status: 401 });
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
   * not exist yet for a just-started agent, so each pushed frame wakes the
   * lookup — frames arrive while an agent works, and the first one after it has
   * said something is when the file appears. The pane can also move to another
   * transcript while watched, which `followTranscript` notices.
   */
  function watchLog(ws: StreamClient, paneId: string): () => void {
    const follow = followTranscript(async () => {
      const pane = store.pane(paneId);
      return pane ? transcriptPathFor(pane, client) : null;
    }, (offset) => {
      if (ws.data.watchedPaneId !== paneId) return;
      ws.send(JSON.stringify({ type: "log_changed", paneId, offset }));
    });

    const wake = () => follow.wake();
    const wakers = logWakers.get(paneId) ?? new Set<() => void>();
    wakers.add(wake);
    logWakers.set(paneId, wakers);

    return () => {
      wakers.delete(wake);
      if (wakers.size === 0 && logWakers.get(paneId) === wakers) logWakers.delete(paneId);
      follow.stop();
    };
  }

  return {
    port: server.port ?? config.port,
    stop: (force) => {
      clearInterval(heartbeat);
      clearInterval(transferSweep);
      clearInterval(conversationRefresh);
      if (sessionBroadcastTimer) clearTimeout(sessionBroadcastTimer);
      for (const ws of [...clients]) { ws.close(1001, "server stopping"); detach(ws); }
      server.stop(force);
    },
    // A relay link cannot become a socket; `/ws` over one is answered 400,
    // which nothing sends — the link *is* the stream.
    dispatch: async (req, rateKey) =>
      (await measuredHandle(req, { rateKey, viaRelay: true, upgrade: null })) ?? new Response(null, { status: 400 }),
    attach,
    detach,
    receive,
  };
}


export async function dashboard(store: SessionStore, poller: Poller, defaultGrouping: string | null = null, client?: HerdrClient) {
  const { state } = store;
  retainSummaries(state.panes.map((pane) => pane.pane_id));

  const panes: DashboardPane[] = await Promise.all(state.panes.map(async (pane) => ({
    paneId: pane.pane_id,
    instanceId: store.instance(pane.pane_id),
    workspaceId: pane.workspace_id,
    workspaceLabel: store.workspace(pane.workspace_id)?.label ?? pane.workspace_id,
    tabId: pane.tab_id,
    status: pane.agent_status,
    agent: pane.display_agent ?? pane.agent ?? null,
    title: paneTitle(pane),
    cwd: pane.cwd ?? null,
    focused: pane.focused,
    isAgent: store.agent(pane.pane_id) !== undefined,
    // The last thing said, for chat-style rows. Summaries are cached by the
    // transcript's file state, so a quiet pane costs one stat here.
    ...await conversationSummary(pane, client),
    // Read after the await above, not before it: clients now take the
    // snapshot's prompt as the current one, and a frame that arrived while a
    // summary was read is newer than one read before it.
    hasPrompt: poller.frame(pane.pane_id)?.prompt != null,
    prompt: pane.agent_status === "blocked" ? (poller.frame(pane.pane_id)?.prompt ?? null) : null,
    activity: poller.frame(pane.pane_id)?.activity ?? null,
  })));



  return {
    version: state.version,
    protocol: state.protocol,
    // The machine the phone is trusting, named. `hostname()` is cheap and the
    // authenticated snapshot is the right place for it — see Session.serverName.
    serverName: hostname(),
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
    panes: latestConversations(panes),
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
  // third-party-notices.txt, which the web build writes beside the app. As
  // octet-stream under nosniff a browser would download it, not show it.
  txt: "text/plain; charset=utf-8",
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
function harden(response: Response, pathname = ""): Response {
  // An API answer is live state, and often a credential: the sign-in's
  // Set-Cookie, a session, what is on a terminal. Only the routes that chose
  // otherwise said anything, so iOS kept the rest on disk — Expo's fetch
  // ignores the app's own `cache: "no-store"` — the passcode login and live
  // cookies included (pre-release bug hunt). A route that wants caching still
  // says so: the transcript's ETag revalidation, immutable images.
  if (pathname.startsWith("/api/") && !response.headers.has("cache-control")) response.headers.set("cache-control", "no-store");
  response.headers.set("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self' ws: wss:; worker-src 'self'; manifest-src 'self'; media-src blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
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
        // Bun's own type for anything the table does not name. The table once
        // lacked `mjs`, so the pdf.js worker went out as octet-stream under
        // nosniff, the browser refused to run it, and no PDF could be
        // previewed from a sidecar-served web build (September 2026
        // pre-release bug hunt). The stub and the hosted fixture use Bun's
        // type for every file, which is why no suite noticed.
        "content-type": CONTENT_TYPES[ext] ?? candidate.type,
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
