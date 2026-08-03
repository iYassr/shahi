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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${path} failed with ${res.status}`);
  }
  return (await res.json()) as T;
}

export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "UnauthorizedError";
  }
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

export const api = {
  authStatus: () => request<{ required: boolean; authenticated: boolean }>("/api/auth/status"),
  login: (passcode: string) => postJson("/api/auth/login", { passcode }),
  logout: () => postJson("/api/auth/logout", {}),

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

  /** Invokes any herdr method. The passcode gate is the boundary, not this. */
  rpc: (method: string, params: unknown = {}) => postJson("/api/rpc", { method, params }),

  /**
   * Answers a numbered prompt by pressing its digit.
   *
   * Verified against a scratch pane: `keys: ["2"]` puts a literal `2` on the
   * process's stdin. A digit does not depend on knowing where the cursor
   * currently sits, which walking it with arrow keys would.
   */
  answerPrompt: (paneId: string, optionIndex: number) =>
    api.rpc("pane.send_keys", { pane_id: paneId, keys: [String(optionIndex)] }),

  sendText: (paneId: string, text: string) => api.rpc("pane.send_text", { pane_id: paneId, text }),

  sendKeys: (paneId: string, keys: string[]) => api.rpc("pane.send_keys", { pane_id: paneId, keys }),

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
  ) =>
    postJson<{ paneId: string; tabId: string | null }>("/api/agents/start", {
      workspaceId,
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
  upload: async (file: File) => {
    const body = new FormData();
    body.append("file", file);
    const res = await fetch("/api/uploads", { method: "POST", credentials: "same-origin", body });
    if (res.status === 401) throw new UnauthorizedError();
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
  createSpace: (label: string, cwdPath: string) =>
    api.rpc("workspace.create", { label, cwd: requireAbsolute(cwdPath), focus: false }),

  createTab: (workspaceId: string, label: string | null, cwdPath: string | null) =>
    api.rpc("tab.create", {
      workspace_id: workspaceId,
      label,
      cwd: cwdPath === null ? null : requireAbsolute(cwdPath),
      focus: false,
    }),

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
    const res = await fetch(url, { credentials: "same-origin" });
    if (res.status === 401) throw new UnauthorizedError();
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? "Cannot read that file");
    }
    return res.text();
  },

  pushKey: () => request<{ publicKey: string | null }>("/api/push/key"),
  pushSubscribe: (subscription: PushSubscriptionJSON) => postJson("/api/push/subscribe", subscription),
  pushTest: () => postJson("/api/push/test", {}),
};

/* ------------------------------------------------------------------------- */

/**
 * Holds the live connection, reconnecting on its own.
 *
 * The watched pane is remembered across reconnects: a phone that locks and
 * wakes should land back on the same live view without the user doing anything.
 */
export class SessionSocket {
  #socket: WebSocket | undefined;
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
    if (this.#socket?.readyState !== WebSocket.OPEN) return;
    this.#socket.send(
      JSON.stringify(paneId ? { type: "watch", paneId } : { type: "unwatch" }),
    );
  }

  #open(): void {
    if (this.#closed) return;
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
