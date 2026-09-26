import { uploadCapability, uploadFile, type UploadOptions, type UploadRequest } from "@shahi/shared/file-upload";
import { downloadFileBytes } from "@shahi/shared/file-download";
import { clearWebDrafts } from "./drafts";
import { createContext, useContext } from "react";
import { browserConnection, forgetBrowser, hosted, keepBlob } from "./connection";
import type { RelayLink, LinkSubscriber } from "@shahi/shared/relay-client";
import { IncompatibleServerError } from "@shahi/shared/errors";
import { SHAHI_API_VERSION, START_AGENT_TIMEOUT_MS, RELAY_LIMITS, type DeviceList, type PromptReceipt } from "@shahi/shared";
/**
 * Client for the Shahi server.
 *
 * Session state arrives over a WebSocket; everything else is plain fetch with
 * the session cookie. The socket reconnects with backoff because a phone
 * suspends it constantly — locking the screen drops it, and unlocking must
 * bring the dashboard straight back without a manual refresh.
 *
 * Every wire type is imported from `@shahi/shared` rather than declared here.
 * They used to be hand-mirrored from the server, with nothing enforcing that
 * the two agreed — which is how `activity` and `cwdPath` each went missing on
 * one side for a while. A React Native client will import the same module.
 */
export type {
  Activity,
  AgentStatus,
  ClientMessage,
  DashboardPane,
  DirEntry,
  DirListing,
  InstalledAgent,
  LogBlock,
  LogMessage,
  PaneFrame,
  ParsedPrompt,
  PromptOption,
  Session,
  SessionLog,
  SocketMessage,
  Space,
  SpaceTab,
  StatusChange,
  StoredUpload,
  TranscriptLine,
} from "@shahi/shared";

import type {
  AgentStatus,
  DirListing,
  PaneFrame,
  ParsedPrompt,
  Session,
  SessionLog,
  SocketMessage,
  TranscriptLine,
} from "@shahi/shared";

export { GAP_MARKER } from "@shahi/shared";

/** Shapes the server returns that are not part of the shared contract. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PaneDetail {
  pane: {
    pane_id: string;
    agent_status: AgentStatus;
    cwd?: string | null;
    agent?: string | null;
  } | null;
  /** Who holds the pane id now (`DashboardPane.instanceId`); absent on older servers. */
  instanceId?: string;
  agent: { name?: string | null } | null;
  layout: { area: Rect } | null;
  frame: PaneFrame | null;
}

export type LinkState = "connecting" | "live" | "lost";

/**
 * How long the server may be silent before the connection counts as dead.
 *
 * The server heartbeats every 20s, so this is two missed beats and a margin.
 * It is the backstop; `offline` usually gets there first.
 */
const SILENCE_LIMIT_MS = 50_000;
const WATCHDOG_INTERVAL_MS = 5_000;

export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
export { IncompatibleServerError };

/**
 * A 426 is the computer declining this contract version, in words that say
 * which side to update. Reported as an ordinary failure it read as
 * "Reconnecting… You don't need to pair again", indefinitely, while every
 * request was refused (pre-release review, 2026-09). Mobile has always
 * mapped it this way.
 */
async function incompatible(res: Response): Promise<IncompatibleServerError> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; api?: { min: number; max: number } };
  return new IncompatibleServerError(
    body.error ?? "This app and the Shahi on this computer do not speak the same version. Update whichever is older.",
    body.api ?? { min: 0, max: 0 },
  );
}

export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "UnauthorizedError";
  }
}

export function requestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createApi(getConnection = browserConnection) {
async function dispatch(path: string, init?: RequestInit): Promise<Response> {
  if (!path.startsWith("/api/") || path.includes("#")) throw new Error("Invalid API path");
  const timeout = path === "/api/agents/start" ? START_AGENT_TIMEOUT_MS : (path === "/api/uploads" || path.startsWith("/api/uploads/")) ? 60_000 : 15_000;
  const headers = new Headers(init?.headers);
  headers.set("x-shahi-api", String(SHAHI_API_VERSION));
  const { link, generation } = getConnection();
  if (browserConnection().generation !== generation) throw new DOMException("Connection changed", "AbortError");
  let res: Response;
  if (link) {
    // Request encodes multipart boundaries without sending anything to the host.
    const encoded = new Request(location.origin + path, { ...init, headers });
    const body = init?.body ? new Uint8Array(await encoded.arrayBuffer()) : null;
    if (browserConnection().generation !== generation) throw new DOMException("Connection changed", "AbortError");
    if (body && body.byteLength > RELAY_LIMITS.maxBodyBytes) throw new Error("This file is too large for the encrypted relay.");
    const reply = await link.request({ method: encoded.method, path, headers: Object.fromEntries(encoded.headers), body }, timeout);
    if (browserConnection().generation !== generation) throw new DOMException("Connection changed", "AbortError");
    const bytes = new Uint8Array(await reply.bytes());
    if (browserConnection().generation !== generation) throw new DOMException("Connection changed", "AbortError");
    res = new Response([204, 205, 304].includes(reply.status) ? null : bytes, { status: reply.status, headers: reply.headers });
  } else {
    if (hosted) throw new UnauthorizedError();
    // A caller's signal joins the deadline rather than replacing it: spread
    // over it, an upload's Cancel would have removed the 60-second limit.
    const deadline = AbortSignal.timeout(timeout);
    const signal = init?.signal ? AbortSignal.any([deadline, init.signal]) : deadline;
    res = await fetch(path, { credentials: "same-origin", ...init, signal, headers });
  }
  if (res.status === 401) {
    if (!hosted) clearWebDrafts("direct");
    if (hosted) { await forgetBrowser(); if (browserConnection().generation !== generation + 1) throw new DOMException("Connection changed", "AbortError"); }
    window.dispatchEvent(new Event("shahi:unauthorized")); throw new UnauthorizedError();
  }
  if (res.status === 426) throw await incompatible(res);
  return res;
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const generation = getConnection().generation;
  const res = await dispatch(path, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? `${path} failed with ${res.status}`, res.status);
  }
  const result = (await res.json()) as T;
  if (browserConnection().generation !== generation) throw new DOMException("Connection changed", "AbortError");
  return result;
}

const postJson = <T = { ok?: boolean; result?: unknown; sent?: number }>(
  path: string,
  body: unknown,
) =>
  request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/**
 * Guards the one mistake herdr will not report.
 *
 * Given a non-absolute `cwd`, herdr neither expands it nor errors — it just
 * uses $HOME, so the space appears to be created correctly and is quietly in
 * the wrong place. Better to fail here, visibly.
 */
function requireAbsolute(path: string): string {
  if (!path.startsWith("/")) {
    throw new Error(`Folder must be an absolute path, got "${path}"`);
  }
  return path;
}

const api = {
  control: async (): Promise<import("@shahi/shared").ControlHandshake | null> => {
    const meta = await dispatch("/api/meta");
    if (!meta.ok) throw new ApiError("Cannot reach this computer.", meta.status);
    if ((await meta.json() as import("@shahi/shared").ServerInfo).control !== 1) return null;
    const res = await dispatch("/api/control/handshake", { headers: { "x-shahi-control": "1" } });
    if (res.status === 404) return null;
    if (!res.ok) throw new ApiError("Cannot read this computer's update status.", res.status);
    const h = await res.json() as import("@shahi/shared").ControlHandshake;
    if (h.control !== 1) throw new Error("Update the app to manage this computer.");
    return h;
  },
  updateComputer: (action: "check" | "install", channel?: import("@shahi/shared").ReleaseChannel) => request("/api/control/update", {
    method: "POST", headers: { "content-type": "application/json", "x-shahi-control": "1" }, body: JSON.stringify({ action, channel }),
  }),
  authStatus: () => request<{ required: boolean; authenticated: boolean }>("/api/auth/status"),
  login: (passcode: string) => postJson("/api/auth/login", { passcode }),
  logout: async () => {
    const id = getConnection().identity?.serverId;
    try { await postJson("/api/auth/logout", {}); }
    finally { if (hosted && id) await forgetBrowser(id); else if (!hosted) clearWebDrafts("direct"); }
  },

  session: () => request<Session>("/api/session"),

  pane: (paneId: string) => request<PaneDetail>(`/api/panes/${encodeURIComponent(paneId)}`),

  /**
   * Claude Code's own transcript for this pane, when it has one.
   *
   * Structured messages rather than a scraped screen — see server/lib/
   * session-log.ts. Returns 404 for shells and for agents that keep no
   * transcript, which is why the caller must fall back to the terminal.
   */
  sessionLog: (paneId: string, opts: { limit?: number; before?: number } = {}) => {
    const query = new URLSearchParams();
    if (opts.limit) query.set("limit", String(opts.limit));
    if (opts.before !== undefined) query.set("before", String(opts.before));
    return request<SessionLog>(
      `/api/panes/${encodeURIComponent(paneId)}/session?${query.toString()}`,
    );
  },

  transcript: (paneId: string, before?: number) =>
    request<{ paneId: string; lines: TranscriptLine[]; total: number }>(
      `/api/panes/${encodeURIComponent(paneId)}/transcript` + (before ? `?before=${before}` : ""),
    ),

  devices: () => request<DeviceList>("/api/devices"),
  revokeDevice: (id: string) => request(`/api/devices/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /**
   * The card's question and context go with the option: every Claude
   * permission offers "1. Yes", so without them a card for one command could
   * approve the next. So does the id of the prompt's appearance, when the
   * server gave one: the same command asked for twice draws the same card.
   *
   * Writes name the pane's occupant they were meant for, when the server named
   * one: herdr reuses pane ids, and the server refuses (409 `pane_replaced`) a
   * write another program would receive.
   */
  answerPrompt: (paneId: string, index: number, label: string, shown?: Pick<ParsedPrompt, "question" | "context" | "promptId">, instanceId?: string) =>
    postJson(`/api/panes/${encodeURIComponent(paneId)}/answer`, {
      index,
      label,
      ...(shown ? { question: shown.question, context: shown.context } : {}),
      ...(shown?.promptId ? { promptId: shown.promptId } : {}),
      ...(instanceId ? { instanceId } : {}),
    }),
  send: (paneId: string, text: string, clientMessageId: string, instanceId?: string) =>
    postJson<PromptReceipt>(`/api/panes/${encodeURIComponent(paneId)}/prompt`, { text, clientMessageId, ...(instanceId ? { instanceId } : {}) }),
  sendKeys: (paneId: string, keys: string[], instanceId?: string) =>
    postJson(`/api/panes/${encodeURIComponent(paneId)}/keys`, { keys, ...(instanceId ? { instanceId } : {}) }),

  /** Agent kinds that could actually start here, resolved in a real shell. */
  agents: () => request<{ agents: { kind: string; command: string }[]; known: number }>("/api/agents"),

  /**
   * Makes a tab and starts an agent in it, in one call.
   *
   * The two herdr calls behind this race each other — the pane exists before
   * its shell does — so the server owns the sequence and the retry. herdr then
   * blocks until the agent reports interactive readiness, which on a cold start
   * is tens of seconds, so the UI has to stay patient rather than assume
   * failure.
   */
  startAgent: (
    workspaceId: string,
    cwdPath: string | null,
    label: string | null,
    kind: string,
    name: string,
    mode: string | null = null,
    clientRequestId: string = requestId(),
    /**
     * The space's name as the sheet showed it. herdr hands a closed space's
     * id to the next one after a restart, and a computer that sees another
     * name there refuses the start rather than put it in the wrong space.
     */
    workspaceLabel?: string,
  ) =>
    postJson<{ paneId: string; tabId: string | null }>("/api/agents/start", {
      clientRequestId,
      workspaceId,
      ...(workspaceLabel === undefined ? {} : { workspaceLabel }),
      cwd: cwdPath === null ? null : requireAbsolute(cwdPath),
      label,
      kind,
      name,
      // A mode id, not flags: the server resolves it, so nothing here decides
      // what runs on the far end.
      mode,
    }),

  dirs: (path = "~", opts: { files?: boolean } = {}) =>
    request<DirListing>(
      `/api/dirs?path=${encodeURIComponent(path)}${opts.files ? "&files=1" : ""}`,
    ),

  /**
   * Sends a file from the phone to the server.
   *
   * Returns the absolute path it landed on, which is what goes into the
   * message — an agent can read a path, it cannot read a browser File.
   */
  upload: async (file: File, options: UploadOptions = {}) => {
    if (file.size > 32 * 1024 * 1024) throw new Error("Files can be up to 32 MB");
    if (getConnection().link) {
      const transferRequest: UploadRequest = (path, init) => dispatch(path, init as RequestInit);
      const limits = await uploadCapability(transferRequest);
      if (limits) return uploadFile(transferRequest, requestId(), {
        name: file.name, type: file.type, size: file.size,
        read: async (offset, count) => new Uint8Array(await file.slice(offset, offset + count).arrayBuffer()),
      }, limits, options);
    }
    if (browserConnection().link && file.size > RELAY_LIMITS.maxBodyBytes - 4096) throw new Error("Update Shahi on your computer to send files up to 32 MB through the tunnel.");
    const body = new FormData();
    body.append("file", file);
    // Cancel upload used to reach only the chunked path: this request ran to
    // the end and the file was attached anyway (pre-release bug hunt). A
    // relay request cannot be withdrawn once sent, so a cancelled one is
    // still not attached.
    const cancelled = () => new Error("Upload cancelled");
    let res: Response;
    try { res = await dispatch("/api/uploads", { method: "POST", body, signal: options.signal }); }
    catch (error) { if (options.signal?.aborted) throw cancelled(); throw error; }
    if (options.signal?.aborted) throw cancelled();
    if (res.status === 401) {
    if (!hosted) clearWebDrafts("direct"); window.dispatchEvent(new Event("shahi:unauthorized")); throw new UnauthorizedError(); }
    const payload = (await res.json().catch(() => ({}))) as {
      error?: string;
      name?: string;
      path?: string;
      size?: number;
    };
    if (!res.ok || !payload.path) throw new Error(payload.error ?? "upload failed");
    return { name: payload.name ?? file.name, path: payload.path, size: payload.size ?? file.size };
  },

  /**
   * Creates a space. Two things matter here.
   *
   * `cwd` must be absolute: herdr does not expand `~`, and rather than
   * rejecting it, it silently falls back to $HOME — so a display path would
   * land every new space in the wrong folder with no error to notice.
   *
   * `focus: false` matters because you are usually attached to this session on
   * a desktop, and a phone should not yank your view sideways.
   */
  createTab: (workspaceId: string, label: string | null, cwdPath: string | null) => postJson(`/api/workspaces/${encodeURIComponent(workspaceId)}/tabs`, { label, cwd: cwdPath === null ? null : requireAbsolute(cwdPath) }),
  createSpace: (label: string, cwdPath: string) =>
    postJson<{ workspaceId: string }>("/api/workspaces", { label, cwd: requireAbsolute(cwdPath) }),

  /**
   * A file an agent touched.
   *
   * A URL rather than bytes: an image goes straight into `src`, and a download
   * is a link the browser handles — fetching either would mean holding the file
   * in memory only to hand it back to the same browser.
   */
  fileUrl: (path: string, options: { download?: boolean } = {}) =>
    `/api/file?path=${encodeURIComponent(path)}${options.download ? "&download=1" : ""}`,

  /** Where a transcript's image lives. */
  imageUrl: (paneId: string, ref: string) =>
    `/api/panes/${encodeURIComponent(paneId)}/image?ref=${encodeURIComponent(ref)}`,

  /** Anything the viewer can show as text, fetched from wherever it lives. */
  textAt: async (url: string) => {
    const res = await dispatch(url);
    if (res.status === 401) {
    if (!hosted) clearWebDrafts("direct"); window.dispatchEvent(new Event("shahi:unauthorized")); throw new UnauthorizedError(); }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? "Cannot read that file");
    }
    return res.text();
  },

  fileBytesAt: async (path: string): Promise<Uint8Array> => {
    const generation = browserConnection().generation;
    const { bytes } = await downloadFileBytes(async headers => {
      const response = await dispatch(path, { headers });
      return { ok: response.ok, status: response.status, headers: response.headers, bytes: async () => new Uint8Array(await response.arrayBuffer()) };
    });
    if (browserConnection().generation !== generation) throw new DOMException("Connection changed", "AbortError");
    return bytes;
  },

  mediaAt: async (path: string, download = false): Promise<string> => {
    const generation = browserConnection().generation;
    const { bytes, contentType: rawType } = await downloadFileBytes(async headers => {
      const response = await dispatch(path, { headers });
      return { ok: response.ok, status: response.status, headers: response.headers, bytes: async () => new Uint8Array(await response.arrayBuffer()) };
    });
    const contentType = rawType.split(";")[0] ?? "application/octet-stream";
    // Agent-authored HTML/SVG must never become executable Blob URLs.
    const safeType = !download && /^image\/(png|jpeg|gif|webp|avif)$/.test(contentType) ? contentType : "application/octet-stream";
    if (browserConnection().generation !== generation) throw new DOMException("Connection changed", "AbortError");
    return keepBlob(new Blob([new Uint8Array(bytes)], { type: safeType }));
  },

  pushKey: () => request<{ publicKey: string | null }>("/api/push/key"),
  pushSubscribe: (subscription: PushSubscriptionJSON) => postJson("/api/push/subscribe", subscription),
  pushUnsubscribe: (endpoint: string) => postJson("/api/push/unsubscribe", { endpoint }),
  pushTest: () => postJson("/api/push/test", {}),
};

/* ------------------------------------------------------------------------- */

/**
 * Holds the live connection, reconnecting on its own.
 *
 * The watched pane is remembered across reconnects: a phone that locks and
 * wakes should land back on the same live view without the user doing anything.
 */
return api;
}
export const api = createApi();
export const ApiContext = createContext(api);
export const useApi = () => useContext(ApiContext);

export class SessionSocket {
  #socket: WebSocket | undefined;
  #relaySubscription: LinkSubscriber | undefined;
  #relay: RelayLink | undefined;
  #backoffMs = 500;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #watchdog: ReturnType<typeof setInterval> | undefined;
  #lastMessageAt = 0;
  #closed = false;
  #watching: string | null = null;

  constructor(
    private readonly onMessage: (msg: SocketMessage) => void,
    private readonly onLink: (state: LinkState) => void,
  ) {}

  connect(): void {
    this.#closed = false;
    const relay = browserConnection().link;
    if (relay) {
      this.#relay = relay;
      this.#relaySubscription = { onMessage: this.onMessage, onLink: this.onLink, onExpired: () => { if (browserConnection().link === relay) window.dispatchEvent(new Event("shahi:unauthorized")); } };
      relay.subscribe(this.#relaySubscription);
      const cached = browserConnection().session;
      if (cached) this.onMessage({ type: "session", session: cached });
      relay.ensureConnected();
      window.addEventListener("online", this.#handleOnline);
      return;
    }
    if (hosted) return;
    this.#open();
    // A socket can die without ever reporting it — a phone sleeping, a network
    // changing under it, a proxy dropping the connection without a close frame.
    // The page then sits there showing "live" over stale data indefinitely. The
    // server's heartbeat is what makes that detectable.
    this.#watchdog ??= setInterval(() => this.#checkAlive(), WATCHDOG_INTERVAL_MS);
    // And when the browser already knows, there is no reason to wait for the
    // heartbeat to time out: losing signal should show immediately, and getting
    // it back should reconnect immediately.
    window.addEventListener("offline", this.#handleOffline);
    window.addEventListener("online", this.#handleOnline);
  }

  close(): void {
    this.#closed = true;
    if (this.#relaySubscription) { this.#relay?.watch(null); this.#relay?.unsubscribe(this.#relaySubscription); }
    this.#relay = undefined;
    this.#relaySubscription = undefined;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#watchdog) clearInterval(this.#watchdog);
    this.#watchdog = undefined;
    window.removeEventListener("offline", this.#handleOffline);
    window.removeEventListener("online", this.#handleOnline);
    this.#socket?.close();
    this.#socket = undefined;
  }

  #handleOffline = () => {
    if (this.#closed) return;
    this.onLink("lost");
    // Chromium keeps an established socket open with the network emulated away,
    // and a phone changing networks does much the same. Closing it makes the
    // reconnect path the only path.
    this.#socket?.close();
  };

  #handleOnline = () => this.ensureConnected();

  /**
   * Reconnects now if the connection is not up.
   *
   * Called when the app comes back to the foreground, where waiting out an
   * exponential backoff would mean staring at stale agents for ten seconds.
   */
  ensureConnected(): void {
    if (this.#closed) return;
    if (this.#relay) { this.#relay.ensureConnected(); return; }
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#checkAlive();
      return;
    }
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#backoffMs = 500;
    this.#open();
  }

  /** True while the server has been heard from recently. */
  get alive(): boolean {
    if (this.#relay) return this.#relay.state === "live";
    return (
      this.#socket?.readyState === WebSocket.OPEN &&
      Date.now() - this.#lastMessageAt < SILENCE_LIMIT_MS
    );
  }

  #checkAlive(): void {
    if (this.#closed || this.#socket?.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.#lastMessageAt < SILENCE_LIMIT_MS) return;
    // Silent for longer than several heartbeats: treat it as gone. `close()`
    // fires `onclose`, which schedules the reconnect.
    this.onLink("lost");
    this.#socket.close();
  }

  watch(paneId: string | null): void {
    this.#watching = paneId;
    if (browserConnection().link) { browserConnection().link!.watch(paneId); return; }
    if (this.#socket?.readyState !== WebSocket.OPEN) return;
    this.#socket.send(
      JSON.stringify(paneId ? { type: "watch", paneId } : { type: "unwatch" }),
    );
  }

  #open(): void {
    if (this.#closed) return;
    if (this.#socket && this.#socket.readyState < WebSocket.CLOSING) return;
    this.onLink("connecting");

    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${location.host}/ws`);
    this.#socket = socket;

    socket.onopen = () => {
      this.#backoffMs = 500;
      this.#lastMessageAt = Date.now();
      this.onLink("live");
      if (this.#watching) socket.send(JSON.stringify({ type: "watch", paneId: this.#watching }));
    };

    socket.onmessage = (event) => {
      if (this.#socket !== socket || this.#closed) return;
      this.#lastMessageAt = Date.now();
      try {
        const message = JSON.parse(String(event.data)) as SocketMessage;
        // The heartbeat's only job is the timestamp above.
        if (message.type !== "ping") this.onMessage(message);
      } catch {
        // A malformed frame is not worth tearing the connection down for.
      }
    };

    socket.onclose = () => {
      if (this.#socket !== socket || this.#closed) return;
      this.#socket = undefined;
      this.onLink("lost");
      this.#retry();
    };

    socket.onerror = () => socket.close();
  }

  #retry(): void {
    if (this.#closed || this.#timer) return;
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(this.#backoffMs * 2, 10_000);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#open();
    }, delay);
  }
}
