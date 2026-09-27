/**
 * Who holds a pane id, as herdr 0.9.1 was measured to hand them out in the
 * pre-release bug hunt: ids grow within a run, a restart gives the highest
 * closed workspace's id to the next new one, and every restored pane gets a
 * new terminal id, its agent and session already set when herdr resumes it.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { PaneInstances, agentSessionOf } from "./herdr-pane";
import type { PaneInfo } from "./herdr-schema";

const pane = (terminal: string, agent: string | null = null, session: string | null = null): PaneInfo => ({
  pane_id: "w3:p1",
  workspace_id: "w3",
  tab_id: "w3:t1",
  terminal_id: terminal,
  agent,
  agent_session: session ? { agent: agent ?? "claude", kind: "id", source: "herdr:claude", value: session } : null,
  agent_status: agent ? "idle" : "unknown",
  focused: false,
  revision: 0,
});

describe("agentSessionOf", () => {
  test("reads a session only while the agent that reported it runs in the pane", () => {
    expect(agentSessionOf(pane("t1", "claude", "s1"))).toBe("s1");
    // herdr restored the pane as a shell and kept the old session on it.
    expect(agentSessionOf({ ...pane("t1", "claude", "s1"), agent: null })).toBeNull();
    expect(agentSessionOf({ ...pane("t1", "claude", "s1"), agent: "codex" })).toBeNull();
    expect(agentSessionOf(undefined)).toBeNull();
  });
});

describe("a pane's occupancy", () => {
  test("a new agent gets a stable start time before its first transcript exists", () => {
    const instances = new PaneInstances();
    instances.observe([pane("old", "claude", "old-session")], 10);
    expect(instances.startedAt("w3:p1")).toBeNull();
    instances.observe([pane("new")], 20);
    instances.observe([pane("new", "codex")], 30);
    expect(instances.startedAt("w3:p1")).toBe(30);
    instances.observe([pane("new", "codex", "new-session")], 40);
    instances.observe([{ ...pane("new", "codex", "new-session"), focused: true, agent_status: "working" }], 50);
    instances.observe([pane("new")], 60);
    instances.observe([pane("new", "codex", "new-session")], 70);
    expect(instances.startedAt("w3:p1")).toBe(30);
    // /new in the same terminal is a new conversation; reporting its id
    // later must not look like a second start of the initial conversation.
    instances.observe([pane("new", "codex", "another-session")], 80);
    expect(instances.startedAt("w3:p1")).toBe(80);
  });

  test("observed starts survive service and herdr restarts, while reused panes start afresh", () => {
    const db = new Database(":memory:");
    const instances = new PaneInstances(db);
    instances.observe([], 10);
    instances.observe([pane("term_a", "claude")], 20);
    instances.observe([pane("term_a", "claude", "s1")], 30);
    const restarted = new PaneInstances(db);
    restarted.observe([pane("term_b", "claude", "s1")], 100);
    expect(restarted.startedAt("w3:p1")).toBe(20);
    restarted.observe([], 110);
    restarted.observe([pane("term_c", "claude", "s2")], 120);
    expect(restarted.startedAt("w3:p1")).toBe(120);
    db.close();
  });

  test("an existing occupancy database gains no invented launch dates on upgrade", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE pane_occupancy (pane_id TEXT PRIMARY KEY, instance TEXT NOT NULL, terminal TEXT NOT NULL, agent TEXT, session TEXT)");
    db.exec("INSERT INTO pane_occupancy VALUES ('w3:p1', 'term_a', 'term_a', 'claude', 's1')");
    const instances = new PaneInstances(db);
    instances.observe([pane("term_a", "claude", "s1")], 100);
    expect(instances.of("w3:p1")).toBe("term_a");
    expect(instances.startedAt("w3:p1")).toBeNull();
    db.close();
  });

  test("a new program under a closed pane's id is a new occupant", () => {
    const instances = new PaneInstances();
    instances.observe([pane("term_a", "claude", "s-a")]);
    const before = instances.of("w3:p1");
    // w3 closed, herdr restarted, a new space took w3 with a shell in w3:p1.
    instances.observe([pane("term_b")]);
    expect(instances.of("w3:p1")).not.toBe(before);
    // And a new agent there is not the old conversation either.
    instances.observe([pane("term_c", "claude", "s-c")]);
    expect(instances.of("w3:p1")).toBe("term_c");
  });

  test("stays the same while its terminal does, through a /clear and a quiet agent", () => {
    const instances = new PaneInstances();
    instances.observe([pane("term_a", "claude", "s-1")]);
    instances.observe([pane("term_a", "claude", "s-2")]);
    instances.observe([pane("term_a")]);
    expect(instances.of("w3:p1")).toBe("term_a");
  });

  test("an agent herdr resumes on the same session keeps its identity across the restart, the sidecar's included", () => {
    const db = new Database(":memory:");
    new PaneInstances(db).observe([pane("term_a", "claude", "s-1")]);
    // Every herdr start restarts the sidecar: a fresh registry on the same database.
    const restarted = new PaneInstances(db);
    restarted.observe([pane("term_b", "claude", "s-1")]);
    expect(restarted.of("w3:p1")).toBe("term_a");
  });

  test("a restored pane whose agent did not come back is a new occupant", () => {
    const db = new Database(":memory:");
    new PaneInstances(db).observe([pane("term_a", "claude", "s-1")]);
    const restarted = new PaneInstances(db);
    restarted.observe([{ ...pane("term_b", "claude", "s-1"), agent: null }]);
    expect(restarted.of("w3:p1")).toBe("term_b");
  });

  test("forgets a pane herdr no longer reports, so its id starts afresh", () => {
    const db = new Database(":memory:");
    const instances = new PaneInstances(db);
    instances.observe([pane("term_a", "claude", "s-1")]);
    instances.observe([]);
    expect(instances.of("w3:p1")).toBeUndefined();
    const restarted = new PaneInstances(db);
    restarted.observe([pane("term_b", "claude", "s-1")]);
    expect(restarted.of("w3:p1")).toBe("term_b");
  });
});
