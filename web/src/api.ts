/**
 * Client for the HerdrUI server.
 *
 * Session state arrives over a WebSocket; everything else is plain fetch with
 * the session cookie. The socket reconnects with backoff because a phone
 * suspends it constantly — locking the screen drops it, and unlocking must
 * bring the dashboard straight back without a manual refresh.
 */

export type AgentStatus = "blocked" | "working" | "done" | "idle" | "unknown";

export interface PromptOption {
  index: number;
  label: string;
  selected: boolean;
}

export interface ParsedPrompt {
  question: string;
  options: PromptOption[];
  hints: string[];
}

export interface DashboardPane {
  paneId: string;
  workspaceId: string;
  workspaceLabel: string;
  tabId: string;
  status: AgentStatus;
  agent: string | null;
  title: string | null;
  cwd: string | null;
  focused: boolean;
  hasPrompt: boolean;
  isAgent: boolean;
  /** Present for blocked panes whose screen could be parsed. */
  prompt: ParsedPrompt | null;
}

/** herdr calls these "spaces" in its sidebar and "workspaces" in its API. */
export interface Space {
  workspaceId: string;
  label: string;
  status: AgentStatus;
  paneCount: number;
  tabCount: number;
  focused: boolean;
  /** Display form, with `~` collapsed. Never send this to herdr. */
  cwd: string | null;
  /** Absolute form, safe to pass back into workspace.create / tab.create. */
  cwdPath: string | null;
}

export interface SpaceTab {
  tabId: string;
  workspaceId: string;
  label: string;
  number: number;
  status: AgentStatus;
  paneCount: number;
  focused: boolean;
}

export interface Session {
  version: string;
  protocol: number;
  /**
   * herdr's own `ui.agent_panel_sort`, so the phone opens the way the TUI
   * already does. Null when no preference is set.
   */
  defaultGrouping: "priority" | "space" | null;
  workspaces: Space[];
  tabs: SpaceTab[];
  panes: DashboardPane[];
  focusedPaneId: string | null;
}

export interface DirEntry {
  name: string;
  path: string;
  display: string;
  isDirectory: boolean;
  size?: number;
}

export interface DirListing {
  path: string;
  display: string;
  parent: string | null;
  entries: DirEntry[];
}

export interface Activity {
  verb: string;
  elapsed: string;
  detail: string | null;
}

export interface PaneFrame {
  paneId: string;
  ansi: string;
  text: string;
  prompt: ParsedPrompt | null;
  /** Present while the agent is mid-turn. Drives the reader's live footer. */
  activity: Activity | null;
  at: number;
}

export type LogBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "image"; mediaType: string }
  | {
      kind: "tool";
      name: string;
      summary: string;
      result: { text: string; isError: boolean; truncated: boolean } | null;
    };

export interface LogMessage {
  id: string;
  role: "you" | "agent" | "system";
  at: number;
  blocks: LogBlock[];
}

export interface SessionLog {
  sessionId: string;
  path: string;
  messages: LogMessage[];
  total: number;
  offset: number;
}

export interface TranscriptLine {
  seq: number;
  text: string;
  at: number;
}

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

/** Matches the server's GAP_MARKER, rendered distinctly in the transcript. */
export const GAP_MARKER = "… output not captured …";

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

const postJson = (path: string, body: unknown) =>
  request<{ ok?: boolean; result?: unknown; sent?: number }>(path, {
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
   * Starts an agent in a pane that is sitting at a shell prompt.
   *
   * herdr blocks until the agent reports interactive readiness, so this can
   * take tens of seconds on a cold start — the server raises the RPC ceiling
   * for it, and the UI has to stay patient rather than assume failure.
   */
  startAgent: (paneId: string, kind: string, name: string) =>
    api.rpc("agent.start", { pane_id: paneId, kind, name }),

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

export type SocketMessage =
  | { type: "session"; session: Session }
  | { type: "frame"; frame: PaneFrame }
  | { type: "prompt"; paneId: string; prompt: ParsedPrompt }
  | { type: "status"; change: { paneId: string; from?: AgentStatus; to: AgentStatus } };

export type LinkState = "connecting" | "live" | "lost";

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
