/**
 * In-memory mirror of the herdr session.
 *
 * Seeded from `session.snapshot` and kept current by the event stream, so the
 * HTTP layer can answer from memory instead of hitting the socket per request.
 *
 * herdr has no event replay, so anything that happens while the subscription is
 * down is simply lost. `HerdrSubscriber` therefore calls `onResync` after every
 * (re)connect, and this module responds by re-snapshotting from scratch rather
 * than trying to patch up a diff it cannot compute.
 */
import { EventEmitter } from "node:events";
import type { HerdrClient } from "./herdr-client";
import type { AnyEvent } from "./herdr-client";
import type {
  AgentInfo,
  AgentStatus,
  PaneInfo,
  PaneLayoutSnapshot,
  SessionSnapshot,
  TabInfo,
  WorkspaceInfo,
} from "./herdr-schema";

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

export interface StatusChange {
  paneId: string;
  workspaceId: string;
  from: AgentStatus | undefined;
  to: AgentStatus;
}

/** Events emitted to the rest of the app. */
export interface SessionStoreEvents {
  /** The mirror changed; the payload is the whole current state. */
  changed: [SessionState];
  /** A pane's agent_status transitioned. Drives push notifications. */
  status: [StatusChange];
  error: [Error];
}

export class SessionStore extends EventEmitter<SessionStoreEvents> {
  #state: SessionState = emptyState();
  #statuses = new Map<string, AgentStatus>();
  #resyncing: Promise<void> | undefined;

  constructor(private readonly client: HerdrClient) {
    super();
  }

  get state(): SessionState {
    return this.#state;
  }

  pane(paneId: string): PaneInfo | undefined {
    return this.#state.panes.find((p) => p.pane_id === paneId);
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

  async #doResync(): Promise<void> {
    try {
      const { snapshot } = await this.client.rpc("session.snapshot", {});
      this.#state = fromSnapshot(snapshot);
      this.#reconcileStatuses();
      this.emit("changed", this.#state);
    } catch (err) {
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

    if (changed) this.emit("changed", this.#state);
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

  /** Emits a `status` event when a pane's agent_status actually transitions. */
  #noteStatus(paneId: string, workspaceId: string, to: AgentStatus): void {
    const from = this.#statuses.get(paneId);
    if (from === to) return;
    this.#statuses.set(paneId, to);
    this.emit("status", { paneId, workspaceId, from, to });
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
      this.#noteStatus(agent.pane_id, agent.workspace_id, agent.agent_status);
    }
    for (const paneId of [...this.#statuses.keys()]) {
      if (!seen.has(paneId)) this.#statuses.delete(paneId);
    }
  }
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
