/**
 * Client for the HerdrUI server.
 *
 * Session state arrives over a WebSocket; everything else is plain fetch with
 * the session cookie. The socket reconnects with backoff because a phone
 * suspends it constantly — locking the screen drops it, and unlocking must
 * bring the dashboard straight back without a manual refresh.
 *
 * Every wire type is imported from `@herdrui/shared` rather than declared here.
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
} from "@herdrui/shared";

import type {
  AgentStatus,
  DirListing,
  PaneFrame,
  Session,
  SessionLog,
  SocketMessage,
  TranscriptLine,
} from "@herdrui/shared";

export { GAP_MARKER } from "@herdrui/shared";

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

/** How a tapped option is delivered. See `api.answerPrompt`. */
const ANSWER_STRATEGY: "digit" | "arrows" = "digit";

/** Cursor movement from the currently selected row to the target, then Enter. */
function arrowPath(from: number, to: number): string[] {
  const distance = Math.abs(to - from);
  const direction = to > from ? "Down" : "Up";
  return [...Array<string>(distance).fill(direction), "Enter"];
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
   * Answers a numbered prompt.
   *
   * Key delivery was verified against a scratch pane: `keys: ["2"]` puts a
   * literal `2` on the process's stdin, and `["Down","Down","Enter"]` arrives in
   * order as `\x1b[B \x1b[B \r`. So both strategies below are mechanically
   * sound; what a scratch pane cannot answer is whether Claude Code's menu
   * widget itself accepts a bare digit, since that needs a real prompt.
   *
   * Digit is the default because it does not depend on knowing where the cursor
   * currently sits. If a tap ever fails to move a real prompt, switch
   * ANSWER_STRATEGY to "arrows": that walks the cursor from the option the
   * parser saw selected to the one you tapped, which works for any menu that
   * responds to arrow keys at all.
   */
  answerPrompt: (paneId: string, optionIndex: number, selectedIndex = 1) =>
    api.rpc("pane.send_keys", {
      pane_id: paneId,
      keys: ANSWER_STRATEGY === "digit" ? [String(optionIndex)] : arrowPath(selectedIndex, optionIndex),
    }),

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
  startAgent: (workspaceId: string, cwdPath: string | null, label: string | null, kind: string, name: string) =>
    postJson<{ paneId: string; tabId: string | null }>("/api/agents/start", {
      workspaceId,
      cwd: cwdPath === null ? null : requireAbsolute(cwdPath),
      label,
      kind,
      name,
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
  #closed = false;
  #watching: string | null = null;

  constructor(
    private readonly onMessage: (msg: SocketMessage) => void,
    private readonly onLink: (state: LinkState) => void,
  ) {}

  connect(): void {
    this.#closed = false;
    this.#open();
  }

  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#socket?.close();
    this.#socket = undefined;
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
      this.onLink("live");
      if (this.#watching) socket.send(JSON.stringify({ type: "watch", paneId: this.#watching }));
    };

    socket.onmessage = (event) => {
      try {
        this.onMessage(JSON.parse(String(event.data)) as SocketMessage);
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
