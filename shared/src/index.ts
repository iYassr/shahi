/**
 * The contract between the server and its clients.
 *
 * Everything here crosses the HTTP or WebSocket boundary, which is exactly why
 * it lives in one place. These types were previously declared twice — once in
 * the server module that produced them, once by hand in the web client — with
 * nothing enforcing agreement. Nine of them had drifted or nearly drifted:
 * adding `activity` to `PaneFrame` meant remembering to edit two files, and
 * adding `cwdPath` to a space was briefly forgotten on the client side.
 *
 * Deliberately types only, with no runtime code. A React Native client will
 * import this same module, and anything importing `node:` or `bun:` would stop
 * that working. Server-internal shapes — the session mirror, herdr's own schema
 * — stay in the server, because a client has no business knowing them.
 */

/* ------------------------------------------------------------------ agents */

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** An installed agent that could actually be started. */
export interface InstalledAgent {
  kind: string;
  command: string;
}

/* ----------------------------------------------------------------- prompts */

export interface PromptOption {
  /** The number the user would press — 1-based, as displayed. */
  index: number;
  label: string;
  /** True for the option currently under the cursor. */
  selected: boolean;
}

export interface ParsedPrompt {
  question: string;
  options: PromptOption[];
  /** Trailing hints under the options. Context, not actionable. */
  hints: string[];
}

/* ---------------------------------------------------------------- activity */

/** What an agent is doing right now, read off its status line. */
export interface Activity {
  verb: string;
  /** Elapsed time as the agent wrote it, e.g. "8m 2s". */
  elapsed: string;
  detail: string | null;
}

/* ------------------------------------------------------------------ frames */

export interface PaneFrame {
  paneId: string;
  /** Raw screen including escape sequences, for xterm.js. */
  ansi: string;
  /** Same screen with escapes stripped. */
  text: string;
  prompt: ParsedPrompt | null;
  activity: Activity | null;
  at: number;
}

/* --------------------------------------------------------------- dashboard */

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
  /** False for plain shells. */
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
  /** Display form, with `~` collapsed. Never send this back to herdr. */
  cwd: string | null;
  /** Absolute form, safe to pass into workspace.create / tab.create. */
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
  /** herdr's own `ui.agent_panel_sort`, so the app opens the way the TUI does. */
  defaultGrouping: "priority" | "space" | null;
  workspaces: Space[];
  tabs: SpaceTab[];
  panes: DashboardPane[];
  focusedPaneId: string | null;
}

/* ----------------------------------------------------------------- reading */

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

/** A line the server recorded as it scrolled off a pane. */
export interface TranscriptLine {
  seq: number;
  text: string;
  at: number;
}

/** Stands in for output that scrolled past between two polls. */
export const GAP_MARKER = "… output not captured …";

/* ------------------------------------------------------------------- files */

export interface DirEntry {
  name: string;
  path: string;
  /** Display form with the home prefix collapsed to `~`. */
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

export interface StoredUpload {
  name: string;
  /** Absolute path, which is what goes into the message. */
  path: string;
  size: number;
  type: string;
}

/* --------------------------------------------------------------- websocket */

export interface StatusChange {
  paneId: string;
  workspaceId: string;
  from?: AgentStatus;
  to: AgentStatus;
}

export type SocketMessage =
  | { type: "session"; session: Session }
  | { type: "frame"; frame: PaneFrame }
  | { type: "prompt"; paneId: string; prompt: ParsedPrompt }
  | { type: "status"; change: StatusChange };

/** What a client sends back. */
export type ClientMessage = { type: "watch"; paneId: string } | { type: "unwatch" };
