import { describe, expect, test } from "bun:test";
import type { AgentStatus, DashboardPane } from "../api";
import { groupPanes } from "./Dashboard";

const pane = (over: Partial<DashboardPane> & { paneId: string }): DashboardPane => ({
  workspaceId: "w1",
  workspaceLabel: "space one",
  tabId: "w1:t1",
  status: "idle" as AgentStatus,
  agent: "claude",
  title: null,
  cwd: null,
  focused: false,
  hasPrompt: false,
  isAgent: true,
  prompt: null,
  preview: null,
  activity: null,
  ...over,
});

describe("groupPanes", () => {
  test("priority keeps the server's order in one group", () => {
    const panes = [pane({ paneId: "a" }), pane({ paneId: "b", workspaceId: "w2" })];
    const groups = groupPanes(panes, "priority");
    expect(groups).toHaveLength(1);
    expect(groups[0]!.panes.map((p) => p.paneId)).toEqual(["a", "b"]);
  });

  test("splits by space, keeping the space's own label", () => {
    const groups = groupPanes(
      [
        pane({ paneId: "a", workspaceId: "w1", workspaceLabel: "alpha" }),
        pane({ paneId: "b", workspaceId: "w2", workspaceLabel: "beta" }),
        pane({ paneId: "c", workspaceId: "w1", workspaceLabel: "alpha" }),
      ],
      "space",
    );
    expect(groups.map((g) => [g.title, g.panes.length])).toEqual([
      ["alpha", 2],
      ["beta", 1],
    ]);
  });

  test("splits by agent and carries the kind for its icon", () => {
    const groups = groupPanes(
      [
        pane({ paneId: "a", agent: "claude" }),
        pane({ paneId: "b", agent: "pi" }),
        pane({ paneId: "c", agent: "claude" }),
      ],
      "agent",
    );
    expect(groups.map((g) => [g.title, g.panes.length, g.icon])).toEqual([
      ["claude", 2, "claude"],
      ["pi", 1, "pi"],
    ]);
  });

  // Ordering has to mean something, or the groups are just a shuffled list.
  test("a group with something working outranks a bigger idle one", () => {
    const groups = groupPanes(
      [
        pane({ paneId: "a", workspaceId: "big", workspaceLabel: "big" }),
        pane({ paneId: "b", workspaceId: "big", workspaceLabel: "big" }),
        pane({ paneId: "c", workspaceId: "big", workspaceLabel: "big" }),
        pane({ paneId: "d", workspaceId: "busy", workspaceLabel: "busy", status: "working" }),
      ],
      "space",
    );
    expect(groups.map((g) => g.title)).toEqual(["busy", "big"]);
  });

  test("equal urgency falls back to size, then name", () => {
    const groups = groupPanes(
      [
        pane({ paneId: "a", workspaceId: "z", workspaceLabel: "zed" }),
        pane({ paneId: "b", workspaceId: "m", workspaceLabel: "mid" }),
        pane({ paneId: "c", workspaceId: "m", workspaceLabel: "mid" }),
        pane({ paneId: "d", workspaceId: "a", workspaceLabel: "aaa" }),
      ],
      "space",
    );
    expect(groups.map((g) => g.title)).toEqual(["mid", "aaa", "zed"]);
  });

  test("an agent with no detected kind still groups", () => {
    const groups = groupPanes([pane({ paneId: "a", agent: null })], "agent");
    expect(groups[0]!.title).toBe("other");
  });

  test("every pane survives grouping", () => {
    const panes = Array.from({ length: 15 }, (_, i) =>
      pane({ paneId: `p${i}`, workspaceId: `w${i % 4}`, agent: i % 3 ? "claude" : "codex" }),
    );
    for (const mode of ["priority", "space", "agent"] as const) {
      const total = groupPanes(panes, mode).flatMap((g) => g.panes);
      expect(total).toHaveLength(15);
      expect(new Set(total.map((p) => p.paneId)).size).toBe(15);
    }
  });
});
