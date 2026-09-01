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
 * Deliberately types only, with one exception: `SHAHI_API_VERSION` is a value,
 * because both sides must agree on one number and a type cannot be compared at
 * runtime. A React Native client imports this same module, and anything
 * importing `node:` or `bun:` would stop that working. Server-internal shapes
 * — the session mirror, herdr's own schema — stay in the server, because a
 * client has no business knowing them.
 */

export * from "./modes";
export * from "./relay";

/* --------------------------------------------------------------- handshake */

/**
 * The version of this contract — the app↔sidecar API, not herdr's protocol.
 *
 * Bump it when a route or payload here changes in a way an older client would
 * misread. A phone cannot be forced to update on the day the sidecar does, so
 * the two negotiate: `GET /api/meta` says what the server speaks, every request
 * carries `x-shahi-api`, and a mismatch is a clear 426 rather than a screen that
 * half-works.
 */
export const SHAHI_API_VERSION = 3;

/** What `GET /api/meta` answers, before any authentication. */
export interface ServerInfo {
  /** Stable per installation, minted once and kept in the database. */
  serverId: string;
  serverVersion: string;
  /** The contract versions this server accepts, inclusive. */
  api: { min: number; max: number };
  herdr: { version: string; protocol: number };
}

/**
 * The answer to `POST /api/panes/:id/prompt`: the prompt was handed to herdr.
 *
 * It confirms delivery only, never the agent's reply — that arrives through the
 * transcript. `clientMessageId` is echoed so a retry after a timeout can be
 * recognised as the same message and not sent twice.
 */
export interface PromptReceipt {
  accepted: true;
  clientMessageId: string;
  acceptedAt: number;
}

/* ----------------------------------------------------------------- pairing */

/**
 * What a pairing code carries, in the fragment of `shahi://pair#…`.
 *
 * A fragment, not a query string, so the secret never reaches a web server if
 * the code is ever opened as a link. `server` is the `ServerInfo.serverId` of
 * the server that minted it: the phone fetches `/api/meta` at `endpoint` and
 * refuses to claim unless the ids match, so a code pointing at the wrong
 * address fails as a mismatch rather than pairing with whatever answered.
 */
export interface PairingPayload {
  v: 1;
  server: string;
  /** Base URL the phone should talk to, e.g. `https://box.tailnet.ts.net`. */
  endpoint: string;
  /**
   * Base URL of a blind relay the box is dialled into (`docs/relay.md`), when
   * it has one. The phone prefers it: it works from anywhere. `endpoint` stays
   * for a phone on the same tailnet.
   */
  relay?: string;
  /** Single use, ten minutes, held in the server's memory only. */
  secret: string;
}

/** What `POST /api/pair` answers: a fresh code, not yet shown to anyone. */
export interface PairingCode {
  secret: string;
  expiresAt: number;
}

/**
 * A phone that was introduced by scanning a code. Passcode logins are not
 * devices: they carry no identity, so there is nothing to list or revoke.
 */
export interface PairedDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
}

/** What `GET /api/devices` answers. */
export interface DeviceList {
  devices: PairedDevice[];
  /** The device the asking session is bound to; null for a passcode login. */
  thisDeviceId: string | null;
}

/* ------------------------------------------------------------------ agents */

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** An installed agent that could actually be started. */
export interface InstalledAgent {
  kind: string;
  command: string;
}

/* ----------------------------------------------------------------- prompts */

export interface PromptOption {
  /**
   * 1-based, in display order. In a numbered menu it is the digit shown and
   * the one the server presses; in a cursor menu it only names the row.
   */
  index: number;
  label: string;
  /** True for the option currently under the cursor. */
  selected: boolean;
  /**
   * The explanation printed under the label, where the agent wrote one.
   *
   * Claude Code's own question tool renders a sentence under each choice, and
   * it is often what the choice actually means — dropping it would leave the
   * phone showing less than the terminal does.
   */
  detail?: string;
}

export interface ParsedPrompt {
  question: string;
  /**
   * How the terminal takes an answer: a `digit` menu (`❯ 1. Yes`) by its
   * number, a `cursor` menu (Claude Code's folder-trust question) by arrow
   * keys and Enter. The phone never presses either itself — it posts the
   * option to `/api/panes/:id/answer` and the server, holding a fresh read of
   * the screen, decides the keystrokes. Shown so the card can drop the
   * numbers where they would mean nothing.
   */
  answer: "digit" | "cursor";
  options: PromptOption[];
  /**
   * What sits between the question and the options — the command an agent
   * wants to run, and its reason for wanting to.
   *
   * codex renders an approval like this:
   *
   *     Would you like to run the following command?
   *     Reason: May I inspect the failing tests?
   *     $ sed -n '1,180p' e2e/stress.spec.ts; …
   *     › 1. Yes, proceed (y)
   *
   * Taken as the question, that command wrapped across eight lines of prose and
   * pushed the answers off the screen — which is what "the codex permission
   * prompt does not show" turned out to mean. It is context: shown, in a
   * monospace block, under the question and above the answers.
   */
  context?: string[];
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
  /**
   * One line of the last thing said in the conversation, for chat-style list
   * rows. Null for shells and agents that have not written a transcript.
   */
  preview: string | null;
  /** What the agent is doing right now, when its status line says. */
  activity: Activity | null;
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
  | {
      kind: "image";
      mediaType: string;
      /** Opaque handle the client exchanges for the bytes. */
      ref: string;
    }
  | {
      kind: "tool";
      name: string;
      summary: string;
      /**
       * The choices offered, when the agent stopped to ask something.
       *
       * A question is not really a tool call — it is the agent talking to you —
       * and rendering it as a collapsed `AskUserQuestion` row hid the entire
       * substance of it. The terminal shows the options; so should this.
       */
      questions?: {
        text: string;
        options: { label: string; description?: string }[];
      }[];
      /**
       * The file this call touched, where it named one.
       *
       * Read, Write and Edit all take a path, and on a phone that path is the
       * most useful thing in the block: it is what you would want to open, and
       * what the agent's own web client lets you open. Absent for anything that
       * did not name a file — a shell command, a search.
       */
      file?: { path: string; name: string };
      result: {
        text: string;
        isError: boolean;
        truncated: boolean;
        /** Refs for images returned by the tool, e.g. Read of a screenshot. */
        images: string[];
      } | null;
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
  /**
   * A heartbeat, every few seconds regardless of activity.
   *
   * The server only speaks when something changes, so silence is ambiguous: a
   * quiet session and a connection that died while the phone was asleep look
   * identical. This makes silence mean something, and keeps the socket from
   * being closed as idle during a long quiet stretch.
   */
  | { type: "ping"; at: number }
  | { type: "session"; session: Session }
  | { type: "frame"; frame: PaneFrame }
  | { type: "prompt"; paneId: string; prompt: ParsedPrompt }
  | { type: "status"; change: StatusChange }
  /**
   * The watched pane's transcript file grew. Sent only to the client watching
   * that pane, and carrying no content: the reader fetches the tail it needs.
   * `offset` is the file size seen, so a client can drop an event for data it
   * already has.
   */
  | { type: "log_changed"; paneId: string; offset: number };

/** What a client sends back. */
export type ClientMessage = { type: "watch"; paneId: string } | { type: "unwatch" };
