import { describe, expect, mock, test } from "bun:test";
import type { HerdrClient } from "./herdr-client";
import type { AgentInfo, PaneInfo, SessionSnapshot, TabInfo, WorkspaceInfo } from "./herdr-schema";
import { SessionStore, type StatusChange } from "./state";

const workspace = (id: string, over: Partial<WorkspaceInfo> = {}): WorkspaceInfo => ({
  workspace_id: id,
  number: 1,
  label: id,
  focused: false,
  pane_count: 1,
  tab_count: 1,
  active_tab_id: `${id}:t1`,
  agent_status: "idle",
  ...over,
});

const tab = (id: string, workspaceId: string, over: Partial<TabInfo> = {}): TabInfo => ({
  tab_id: id,
  workspace_id: workspaceId,
  number: 1,
  label: id,
  focused: false,
  pane_count: 1,
  agent_status: "idle",
  ...over,
});

const pane = (id: string, workspaceId: string, over: Partial<PaneInfo> = {}): PaneInfo => ({
  pane_id: id,
  terminal_id: `term_${id}`,
  workspace_id: workspaceId,
  tab_id: `${workspaceId}:t1`,
  focused: false,
  agent_status: "idle",
  revision: 0,
  ...over,
});

const agent = (id: string, workspaceId: string, over: Partial<AgentInfo> = {}): AgentInfo => ({
  ...pane(id, workspaceId),
  state_change_seq: 0,
  ...over,
});

function snapshot(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    version: "0.7.5",
    protocol: 17,
    workspaces: [workspace("w1")],
    tabs: [tab("w1:t1", "w1")],
    panes: [pane("w1:p1", "w1")],
    agents: [agent("w1:p1", "w1")],
    layouts: [],
    ...over,
  };
}

/** A HerdrClient stand-in that only answers `session.snapshot`. */
function fakeClient(snapshots: SessionSnapshot[]) {
  const queue = [...snapshots];
  let last = queue[0]!;
  const rpc = mock(async (method: string) => {
    if (method !== "session.snapshot") throw new Error(`unexpected rpc: ${method}`);
    last = queue.shift() ?? last;
    return { type: "session_snapshot", snapshot: last };
  });
  return { client: { rpc } as unknown as HerdrClient, rpc };
}

describe("SessionStore", () => {
  test("seeds from a snapshot", async () => {
    const { client } = fakeClient([snapshot()]);
    const store = new SessionStore(client);
    await store.resync();

    expect(store.state.version).toBe("0.7.5");
    expect(store.state.panes).toHaveLength(1);
    expect(store.pane("w1:p1")?.pane_id).toBe("w1:p1");
    expect(store.agent("w1:p1")?.pane_id).toBe("w1:p1");
    expect(store.workspace("w1")?.label).toBe("w1");
  });

  test("coalesces concurrent resyncs into one request", async () => {
    const { client, rpc } = fakeClient([snapshot()]);
    const store = new SessionStore(client);

    await Promise.all([store.resync(), store.resync(), store.resync()]);
    expect(rpc).toHaveBeenCalledTimes(1);

    // A later resync is a fresh request, not a cached one.
    await store.resync();
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  test("surfaces snapshot failures without throwing", async () => {
    const rpc = mock(async () => {
      throw new Error("socket gone");
    });
    const store = new SessionStore({ rpc } as unknown as HerdrClient);
    const errors: Error[] = [];
    store.on("error", (e) => errors.push(e));

    await store.resync();
    expect(errors.map((e) => e.message)).toEqual(["socket gone"]);
  });

  test("applies pane_updated in place", async () => {
    const { client } = fakeClient([snapshot()]);
    const store = new SessionStore(client);
    await store.resync();

    store.apply({
      event: "pane_updated",
      data: {
        type: "pane_updated",
        pane: pane("w1:p1", "w1", { agent_status: "working", terminal_title: "building" }),
      },
    } as never);

    expect(store.pane("w1:p1")?.agent_status).toBe("working");
    expect(store.pane("w1:p1")?.terminal_title).toBe("building");
    // The AgentInfo view tracks the same pane.
    expect(store.agent("w1:p1")?.agent_status).toBe("working");
    expect(store.state.panes).toHaveLength(1);
  });

  test("adds a pane on pane_created and drops it on pane_closed", async () => {
    const { client } = fakeClient([snapshot()]);
    const store = new SessionStore(client);
    await store.resync();

    store.apply({
      event: "pane_created",
      data: { type: "pane_created", pane: pane("w1:p2", "w1") },
    } as never);
    expect(store.state.panes).toHaveLength(2);

    store.apply({
      event: "pane_closed",
      data: { type: "pane_closed", pane_id: "w1:p2", workspace_id: "w1" },
    } as never);
    expect(store.state.panes).toHaveLength(1);
    expect(store.pane("w1:p2")).toBeUndefined();
  });

  test("moves focus exclusively", async () => {
    const { client } = fakeClient([
      snapshot({
        panes: [pane("w1:p1", "w1", { focused: true }), pane("w1:p2", "w1")],
        agents: [],
      }),
    ]);
    const store = new SessionStore(client);
    await store.resync();

    store.apply({
      event: "pane_focused",
      data: { type: "pane_focused", pane_id: "w1:p2", workspace_id: "w1" },
    } as never);

    expect(store.pane("w1:p1")?.focused).toBe(false);
    expect(store.pane("w1:p2")?.focused).toBe(true);
    expect(store.state.focusedPaneId).toBe("w1:p2");
  });

  test("renames a workspace without a resync", async () => {
    const { client, rpc } = fakeClient([snapshot()]);
    const store = new SessionStore(client);
    await store.resync();

    store.apply({
      event: "workspace_renamed",
      data: { type: "workspace_renamed", workspace_id: "w1", label: "security program" },
    } as never);

    expect(store.workspace("w1")?.label).toBe("security program");
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  // Some events carry too little to patch the mirror safely — a moved pane
  // reshuffles several collections at once. Those must fall back to a resync.
  test("resyncs on events whose payloads are too partial to apply", async () => {
    const { client, rpc } = fakeClient([snapshot(), snapshot({ panes: [], agents: [] })]);
    const store = new SessionStore(client);
    await store.resync();
    expect(rpc).toHaveBeenCalledTimes(1);

    store.apply({ event: "pane_moved", data: { type: "pane_moved" } } as never);
    await Bun.sleep(5);

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(store.state.panes).toHaveLength(0);
  });

  describe("status transitions", () => {
    test("emits on a real change and stays quiet otherwise", async () => {
      const { client } = fakeClient([snapshot()]);
      const store = new SessionStore(client);
      const changes: StatusChange[] = [];
      store.on("status", (c) => changes.push(c));

      await store.resync();
      // The initial snapshot establishes a baseline: idle, reported once.
      expect(changes).toEqual([
        { paneId: "w1:p1", workspaceId: "w1", from: undefined, to: "idle" },
      ]);

      changes.length = 0;
      store.apply({
        event: "pane_updated",
        data: { type: "pane_updated", pane: pane("w1:p1", "w1", { agent_status: "blocked" }) },
      } as never);
      expect(changes).toEqual([
        { paneId: "w1:p1", workspaceId: "w1", from: "idle", to: "blocked" },
      ]);

      // Re-reporting the same status is not a transition.
      changes.length = 0;
      store.apply({
        event: "pane_updated",
        data: { type: "pane_updated", pane: pane("w1:p1", "w1", { agent_status: "blocked" }) },
      } as never);
      expect(changes).toEqual([]);
    });

    // The whole notification path hangs on this: if a transition to `blocked`
    // happens while the subscription is down, herdr will never replay it, so
    // the resync has to notice.
    test("reports a transition that happened while disconnected", async () => {
      const { client } = fakeClient([
        snapshot(),
        snapshot({ agents: [agent("w1:p1", "w1", { agent_status: "blocked" })] }),
      ]);
      const store = new SessionStore(client);
      await store.resync();

      const changes: StatusChange[] = [];
      store.on("status", (c) => changes.push(c));

      await store.resync();
      expect(changes).toEqual([
        { paneId: "w1:p1", workspaceId: "w1", from: "idle", to: "blocked" },
      ]);
    });

    test("forgets panes that vanished across a resync", async () => {
      const { client } = fakeClient([
        snapshot(),
        snapshot({ panes: [], agents: [] }),
        snapshot(),
      ]);
      const store = new SessionStore(client);
      await store.resync();
      await store.resync();

      const changes: StatusChange[] = [];
      store.on("status", (c) => changes.push(c));

      // The pane returning is a fresh sighting, not a continuation.
      await store.resync();
      expect(changes).toEqual([
        { paneId: "w1:p1", workspaceId: "w1", from: undefined, to: "idle" },
      ]);
    });
  });

  test("finds the layout that sizes a pane's terminal", async () => {
    const { client } = fakeClient([
      snapshot({
        layouts: [
          {
            workspace_id: "w1",
            tab_id: "w1:t1",
            zoomed: false,
            area: { x: 26, y: 1, width: 146, height: 42 },
            focused_pane_id: "w1:p1",
            panes: [{ pane_id: "w1:p1", focused: true, rect: { x: 26, y: 1, width: 146, height: 42 } }],
            splits: [],
          },
        ],
      }),
    ]);
    const store = new SessionStore(client);
    await store.resync();

    const layout = store.layoutForPane("w1:p1");
    expect(layout?.area).toEqual({ x: 26, y: 1, width: 146, height: 42 });
    expect(store.layoutForPane("nope:p9")).toBeUndefined();
  });
});
