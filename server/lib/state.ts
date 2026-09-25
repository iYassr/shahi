/**
 * In-memory mirror of the herdr session.
 *
 * Seeded from `session.snapshot`, patched by the event stream for responsiveness,
 * and re-snapshotted on a timer because **events alone do not keep it true**.
 *
 * That last point was measured, not assumed. The obvious design is to subscribe
 * to the unfiltered `pane.updated` topic, which carries a full `PaneInfo`
 * including `agent_status`, and conclude that one connection covers every pane.
 * It does not: `pane.updated` fires for pane metadata, while a pure status
 * transition is only announced on `pane.agent_status_changed`, and *that* topic
 * requires an explicit `pane_id` per subscription. A drift check comparing the
 * mirror against live snapshots failed 18 times out of 18, with entries like
 * `w4:p2: mirror=idle herdr=blocked` — precisely the agent the whole app exists
 * to surface.
 *
 * Periodic re-snapshotting fixes it without having to manage a subscription per
 * pane across creation and closure. It costs one ~30KB RPC every few seconds,
 * which measured as noise against the herdr server's baseline CPU, and it
 * doubles as the recovery path after a dropped connection — herdr has no event
 * replay, so anything missed while disconnected can only be recovered by asking
 * again.
 */
import type { StatusChange as WireStatusChange } from "@shahi/shared";
import { EventEmitter } from "node:events";
import type { HerdrClient } from "./herdr-client";
import type { AnyEvent } from "./herdr-client";
import { PaneInstances } from "./herdr-pane";
import type {
  AgentInfo,
  AgentStatus,
  PaneInfo,
  PaneLayoutSnapshot,
  SessionSnapshot,
  TabInfo,
  WorkspaceInfo,
} from "./herdr-schema";

/**
 * A status change as the store observed it: the wire shape, plus whether it
 * came from the first snapshot this process took.
 *
 * `from: undefined` used to stand for that baseline, but it also means "a pane
 * this store has not seen before" — a new agent that blocks within one
 * snapshot, or a pane that left `agents` and came back — and push dropped
 * those questions as baseline noise (pre-release bug hunt: 4 of 6 agents that
 * went from unknown to blocked within a second were never notified). Only the
 * baseline is `initial`.
 *
 * `from === to === "blocked"` is a re-block the store cannot see directly:
 * herdr's state counter proves the pane left `blocked` and came back between
 * two snapshots. See `#noteStatus`.
 */
export interface StatusChange extends WireStatusChange {
  initial?: boolean;
}

/** Ordering for the dashboard: what needs a human first. */
export const STATUS_PRIORITY: Record<AgentStatus, number> = {
  blocked: 0,
  working: 1,
  done: 2,
  idle: 3,
  unknown: 4,
};

export interface SessionState {
  version: string;
  protocol: number;
  workspaces: WorkspaceInfo[];
  tabs: TabInfo[];
  panes: PaneInfo[];
  agents: AgentInfo[];
  layouts: PaneLayoutSnapshot[];
  focusedWorkspaceId: string | null;
  focusedTabId: string | null;
  focusedPaneId: string | null;
}


/** Events emitted to the rest of the app. */
export interface SessionStoreEvents {
  /** The mirror changed; the payload is the whole current state. */
  changed: [SessionState];
  /** A pane's agent_status transitioned. Drives push notifications. */
  status: [StatusChange];
  error: [Error];
}

/**
 * How often to re-snapshot.
 *
 * This is the worst-case delay between an agent blocking and the phone being
 * told, so it wants to be short; it is also a whole-session read, so it wants
 * not to be absurd. Three seconds is imperceptible for "an agent needs you" and
 * measured as noise against herdr's own CPU.
 */
const SYNC_INTERVAL_MS = 3_000;

export class SessionStore extends EventEmitter<SessionStoreEvents> {
  lastSyncOk = false;
  #state: SessionState = emptyState();
  #statuses = new Map<string, AgentStatus>();
  /** herdr's `state_change_seq` per pane, as of the last snapshot that carried it. */
  #seqs = new Map<string, number>();
  /** Set once the first snapshot has been reconciled; see `StatusChange.initial`. */
  #baselined = false;
  #resyncing: Promise<void> | undefined;
  #syncTimer: ReturnType<typeof setInterval> | undefined;
  #signature = "";

  /**
   * `instances` names each pane's occupant (see `PaneInstances`). The server
   * passes one backed by its database, so a restored agent keeps its identity
   * across the sidecar restart that comes with every herdr start.
   */
  constructor(
    private readonly client: HerdrClient,
    private readonly instances = new PaneInstances(),
  ) {
    super();
  }

  /**
   * Begins periodic re-snapshotting.
   *
   * Runs regardless of whether any client is connected: push notifications
   * depend on noticing a transition to `blocked`, and that has to work while
   * the phone is asleep.
   */
  startSync(intervalMs = SYNC_INTERVAL_MS): void {
    this.#syncTimer ??= setInterval(() => void this.resync(), intervalMs);
  }

  stopSync(): void {
    if (this.#syncTimer) clearInterval(this.#syncTimer);
    this.#syncTimer = undefined;
  }

  get state(): SessionState {
    return this.#state;
  }

  pane(paneId: string): PaneInfo | undefined {
    return this.#state.panes.find((p) => p.pane_id === paneId);
  }

  /** Which occupancy holds the pane id now; changes when another program takes the id. */
  instance(paneId: string): string | undefined {
    return this.instances.of(paneId);
  }

  agent(paneId: string): AgentInfo | undefined {
    return this.#state.agents.find((a) => a.pane_id === paneId);
  }

  workspace(workspaceId: string): WorkspaceInfo | undefined {
    return this.#state.workspaces.find((w) => w.workspace_id === workspaceId);
  }

  /** Layout for the tab a pane lives in — the source of xterm.js dimensions. */
  layoutForPane(paneId: string): PaneLayoutSnapshot | undefined {
    const pane = this.pane(paneId);
    if (!pane) return undefined;
    return this.#state.layouts.find((l) => l.tab_id === pane.tab_id);
  }

  /**
   * Rebuilds the mirror from a fresh snapshot.
   *
   * Concurrent calls share one in-flight request: a reconnect storm should not
   * turn into a snapshot storm.
   */
  async resync(): Promise<void> {
    this.#resyncing ??= this.#doResync().finally(() => {
      this.#resyncing = undefined;
    });
    return this.#resyncing;
  }

  /** A snapshot already in flight may predate the write we just completed. */
  async resyncAfterMutation(): Promise<void> {
    await this.#resyncing;
    await this.resync();
    if (!this.lastSyncOk) throw new Error("Could not refresh the computer after creating the conversation");
  }

  async #doResync(): Promise<void> {
    try {
      const { snapshot } = await this.client.rpc("session.snapshot", {});
      this.#state = fromSnapshot(snapshot);
      this.instances.observe(this.#state.panes);
      this.lastSyncOk = true;

      // Status transitions are reported even when nothing else moved, because
      // they are what drive notifications.
      this.#reconcileStatuses();

      // The snapshot runs on a timer, so most of them find nothing new. Emitting
      // regardless would push a full dashboard to every connected phone every
      // few seconds for no reason.
      const signature = signatureOf(this.#state);
      if (signature !== this.#signature) {
        this.#signature = signature;
        this.emit("changed", this.#state);
      }
    } catch (err) {
      this.lastSyncOk = false;
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Applies one event from the subscription stream.
   *
   * Only events that carry enough payload to patch the mirror are applied
   * in place. Structural events whose payloads are partial (a moved pane
   * reshuffling several collections, a closed workspace) trigger a resync
   * instead — correctness over cleverness, and they are rare.
   */
  apply(event: AnyEvent): void {
    const { data } = event;
    let changed = true;

    switch (event.event) {
      case "pane_created":
      case "pane_updated":
        this.#upsertPane((data as { pane: PaneInfo }).pane);
        break;

      case "pane_closed":
      case "pane_exited": {
        const { pane_id } = data as { pane_id: string };
        this.#state.panes = this.#state.panes.filter((p) => p.pane_id !== pane_id);
        this.#state.agents = this.#state.agents.filter((a) => a.pane_id !== pane_id);
        this.#statuses.delete(pane_id);
        this.#seqs.delete(pane_id);
        break;
      }

      case "pane_focused": {
        const { pane_id, workspace_id } = data as { pane_id: string; workspace_id: string };
        this.#state.focusedPaneId = pane_id;
        this.#state.focusedWorkspaceId = workspace_id;
        for (const p of this.#state.panes) p.focused = p.pane_id === pane_id;
        break;
      }

      case "pane_agent_status_changed": {
        const d = data as { pane_id: string; workspace_id: string; agent_status: AgentStatus };
        const pane = this.pane(d.pane_id);
        if (pane) pane.agent_status = d.agent_status;
        const agent = this.agent(d.pane_id);
        if (agent) agent.agent_status = d.agent_status;
        this.#noteStatus(d.pane_id, d.workspace_id, d.agent_status);
        break;
      }

      case "workspace_created":
      case "workspace_updated":
      case "workspace_metadata_updated":
        this.#upsertWorkspace((data as { workspace: WorkspaceInfo }).workspace);
        break;

      case "workspace_renamed": {
        const { workspace_id, label } = data as { workspace_id: string; label: string };
        const ws = this.workspace(workspace_id);
        if (ws) ws.label = label;
        break;
      }

      case "workspace_focused": {
        const { workspace_id } = data as { workspace_id: string };
        this.#state.focusedWorkspaceId = workspace_id;
        for (const w of this.#state.workspaces) w.focused = w.workspace_id === workspace_id;
        break;
      }

      case "tab_created":
        this.#upsertTab((data as { tab: TabInfo }).tab);
        break;

      case "tab_renamed": {
        const { tab_id, label } = data as { tab_id: string; label: string };
        const tab = this.#state.tabs.find((t) => t.tab_id === tab_id);
        if (tab) tab.label = label;
        break;
      }

      case "tab_focused": {
        const { tab_id, workspace_id } = data as { tab_id: string; workspace_id: string };
        this.#state.focusedTabId = tab_id;
        for (const t of this.#state.tabs) t.focused = t.tab_id === tab_id;
        const ws = this.workspace(workspace_id);
        if (ws) ws.active_tab_id = tab_id;
        break;
      }

      case "tab_closed": {
        const { tab_id } = data as { tab_id: string };
        this.#state.tabs = this.#state.tabs.filter((t) => t.tab_id !== tab_id);
        break;
      }

      case "layout_updated":
        this.#upsertLayout((data as { layout: PaneLayoutSnapshot }).layout);
        break;

      // Payloads too partial to patch safely — reshuffles, closures, and
      // worktree churn all touch several collections at once.
      case "pane_moved":
      case "workspace_closed":
      case "workspace_moved":
      case "tab_moved":
      case "worktree_created":
      case "worktree_opened":
      case "worktree_removed":
        void this.resync();
        return;

      // `pane_agent_detected` only reports *that* detection ran; the follow-up
      // `pane_updated` carries the resulting PaneInfo.
      default:
        changed = false;
        break;
    }

    if (changed) {
      this.instances.observe(this.#state.panes);
      this.#signature = signatureOf(this.#state);
      this.emit("changed", this.#state);
    }
  }

  #upsertPane(pane: PaneInfo): void {
    upsert(this.#state.panes, pane, (p) => p.pane_id === pane.pane_id);

    // A pane with a detected agent also appears in `agents`, carrying the extra
    // AgentInfo fields. Refresh what we can without inventing the rest: if the
    // agent is new to us, a resync fills in the full record.
    const existing = this.agent(pane.pane_id);
    if (existing) {
      Object.assign(existing, pane);
    } else if (pane.agent) {
      void this.resync();
    }

    this.#noteStatus(pane.pane_id, pane.workspace_id, pane.agent_status);
  }

  #upsertWorkspace(workspace: WorkspaceInfo): void {
    upsert(this.#state.workspaces, workspace, (w) => w.workspace_id === workspace.workspace_id);
  }

  #upsertTab(tab: TabInfo): void {
    upsert(this.#state.tabs, tab, (t) => t.tab_id === tab.tab_id);
  }

  #upsertLayout(layout: PaneLayoutSnapshot): void {
    upsert(this.#state.layouts, layout, (l) => l.tab_id === layout.tab_id);
  }

  /**
   * Emits a `status` event when a pane's agent_status actually transitions.
   *
   * `seq` is herdr's `state_change_seq`, which only snapshots carry. Status is
   * sampled — every 3s, or when a title change happens to send `pane.updated`
   * — so an agent answered and blocked again inside one sample reads as
   * blocked → blocked, and its second question was never notified however
   * long it waited (pre-release bug hunt). The counter closes that gap:
   * measured on herdr 0.9.1 it is session-wide and advances on every status
   * change and on nothing else (not a repeated report of the same state, a
   * title, a label or metadata), so a pane still blocked with a higher number
   * than last time has left `blocked` and come back.
   *
   * An event's change carries no number, and the next snapshot's number
   * already counts it, so an event forgets the pane's number rather than let
   * that snapshot read it as a second block.
   */
  #noteStatus(paneId: string, workspaceId: string, to: AgentStatus, seq?: number): void {
    const from = this.#statuses.get(paneId);
    const lastSeq = this.#seqs.get(paneId);
    if (seq === undefined) {
      if (from === to) return;
      this.#seqs.delete(paneId);
    } else {
      this.#seqs.set(paneId, seq);
      // A lower number is a restarted herdr's fresh counter, not a new block.
      const reblocked = to === "blocked" && from === to && lastSeq !== undefined && seq > lastSeq;
      if (from === to && !reblocked) return;
    }
    this.#statuses.set(paneId, to);
    this.emit("status", { paneId, workspaceId, from, to, ...(this.#baselined ? {} : { initial: true }) });
  }

  /**
   * Re-baselines statuses after a resync.
   *
   * Transitions that happened while we were disconnected are reported now, so a
   * dropped subscription cannot swallow the "an agent needs you" signal that
   * the whole notification path depends on.
   */
  #reconcileStatuses(): void {
    const seen = new Set<string>();
    for (const agent of this.#state.agents) {
      seen.add(agent.pane_id);
      this.#noteStatus(agent.pane_id, agent.workspace_id, agent.agent_status, agent.state_change_seq);
    }
    for (const paneId of [...this.#statuses.keys()]) {
      if (!seen.has(paneId)) {
        this.#statuses.delete(paneId);
        this.#seqs.delete(paneId);
      }
    }
    // Everything before this point was already true when the process started.
    // A herdr restart does not re-arm it: a restored pane that blocks is news.
    this.#baselined = true;
  }
}

/**
 * A compact fingerprint of everything the dashboard renders.
 *
 * Covers status, title and structure but deliberately not fields that churn
 * without being visible (revisions, scroll offsets), so a timer-driven resync
 * only wakes clients when something they can actually see has changed.
 */
function signatureOf(state: SessionState): string {
  // Everything a rendered row or the Spaces grouping depends on, and who
  // occupies each pane: a new terminal under a reused id changes what clients
  // may keep for that pane (see `PaneInstances`), even when nothing on the row
  // looks different. It grew to
  // include a pane's tab and cwd (rows show the working folder, Spaces groups
  // panes under their tab) and a tabs section (a rename, close or move must
  // wake clients) — omitting them let the internal mirror recover while no
  // client was told, so tab renames/closes and pane moves stayed stale until
  // an unrelated event nudged a broadcast. Still excludes churn nobody sees
  // (revisions, scroll offsets), so a resync only fires on visible change.
  const panes = state.panes
    .map(
      (p) =>
        `${p.pane_id}:${p.terminal_id ?? ""}:${p.agent_status}:${p.agent ?? ""}:${p.tab_id ?? ""}:${p.cwd ?? ""}:${p.focused ? 1 : 0}:${p.terminal_title_stripped ?? p.terminal_title ?? ""}`,
    )
    .sort()
    .join("|");
  const tabs = state.tabs
    .map((t) => `${t.tab_id}:${t.workspace_id}:${t.label ?? ""}`)
    .sort()
    .join("|");
  const workspaces = state.workspaces
    .map((w) => `${w.workspace_id}:${w.label}:${w.agent_status}:${w.pane_count}:${w.tab_count}`)
    .sort()
    .join("|");
  return `${state.focusedPaneId}~${workspaces}~${tabs}~${panes}`;
}

function upsert<T>(list: T[], item: T, match: (candidate: T) => boolean): void {
  const index = list.findIndex(match);
  if (index === -1) list.push(item);
  else list[index] = item;
}

function fromSnapshot(snapshot: SessionSnapshot): SessionState {
  return {
    version: snapshot.version,
    protocol: snapshot.protocol,
    workspaces: snapshot.workspaces,
    tabs: snapshot.tabs,
    panes: snapshot.panes,
    agents: snapshot.agents,
    layouts: snapshot.layouts,
    focusedWorkspaceId: snapshot.focused_workspace_id ?? null,
    focusedTabId: snapshot.focused_tab_id ?? null,
    focusedPaneId: snapshot.focused_pane_id ?? null,
  };
}

function emptyState(): SessionState {
  return {
    version: "",
    protocol: 0,
    workspaces: [],
    tabs: [],
    panes: [],
    agents: [],
    layouts: [],
    focusedWorkspaceId: null,
    focusedTabId: null,
    focusedPaneId: null,
  };
}
