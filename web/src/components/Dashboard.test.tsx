import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";
import type { AgentStatus, DashboardPane, Session } from "../api";
import { Dashboard, groupPanes } from "./Dashboard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

// herdr reuses pane ids: close the highest space, restart herdr, create one,
// and its panes have the old ids. The pre-release bug hunt pinned w3:p1 and
// found the next conversation to get that id starred and sorted first.
describe("pins", () => {
  let view: ReactTestRenderer | undefined;
  const stored = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  beforeAll(() => Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value), removeItem: (key: string) => void stored.delete(key) },
  }));
  afterAll(() => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous); else Reflect.deleteProperty(globalThis, "localStorage");
  });
  afterEach(async () => {
    if (view) await act(async () => view!.unmount());
    view = undefined;
    stored.clear();
  });
  const session = (...panes: DashboardPane[]) => ({ version: "0.9.1", panes } as unknown as Session);
  const tree = (current: Session) => <MemoryRouter><Dashboard session={current} prompts={{}} onAnswer={mock()} reviewed={{}} onReviewed={mock()} /></MemoryRouter>;
  const pin = (title: string) => view!.root.findAll((node) => node.type === "button" && typeof node.props["aria-label"] === "string" && node.props["aria-label"].endsWith(` ${title}`))[0]!;

  test("a pin on one conversation does not pin the next conversation to get its pane id", async () => {
    const first = pane({ paneId: "w3:p1", instanceId: "term_a", title: "Roll back prod" });
    await act(async () => { view = create(tree(session(first, pane({ paneId: "w1:p1", title: "Other" })))); });
    await act(async () => pin("Roll back prod").props.onClick());
    expect(pin("Roll back prod").props["aria-pressed"]).toBe(true);

    // The pane id comes back holding another program, with no list between.
    const next = pane({ paneId: "w3:p1", instanceId: "term_b", title: "Unrelated work" });
    await act(async () => view!.update(tree(session(next, pane({ paneId: "w1:p1", title: "Other" })))));
    expect(pin("Unrelated work").props["aria-pressed"]).toBe(false);
    expect(JSON.parse(stored.get("shahi.pins")!)).toEqual([]);
  });

  test("while a pin stays with its conversation, and an older server's pins go by pane id", async () => {
    const first = pane({ paneId: "w3:p1", instanceId: "term_a", title: "Roll back prod" });
    await act(async () => { view = create(tree(session(first))); });
    await act(async () => pin("Roll back prod").props.onClick());
    await act(async () => view!.update(tree(session({ ...first, preview: "moved on" }))));
    expect(pin("Roll back prod").props["aria-pressed"]).toBe(true);

    await act(async () => view!.unmount());
    stored.clear();
    const older = pane({ paneId: "w2:p1", title: "Older server" });
    await act(async () => { view = create(tree(session(older))); });
    await act(async () => pin("Older server").props.onClick());
    expect(pin("Older server").props["aria-pressed"]).toBe(true);
  });
});

// Pre-release bug hunt: the list said "1 AGENTS" on the phone, and this one
// said "1 agents" beside its count.
test("one conversation is counted in the singular, and shells as shells", () => {
  expect(groupPanes([pane({ paneId: "a" })], "priority")[0]!.title).toBe("1 agent");
  expect(groupPanes([pane({ paneId: "a" }), pane({ paneId: "b" })], "priority")[0]!.title).toBe("2 agents");
  expect(groupPanes([pane({ paneId: "a", isAgent: false })], "priority", "shell")[0]!.title).toBe("1 shell");
});

describe("what a conversation is called", () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  let view: ReactTestRenderer | undefined;
  afterEach(async () => { if (view) await act(async () => view!.unmount()); view = undefined; });
  async function render(panes: DashboardPane[]) {
    const session = { panes, workspaces: [], defaultGrouping: "priority" } as unknown as Session;
    await act(async () => { view = create(<MemoryRouter><Dashboard session={session} prompts={{}} reviewed={{}} onReviewed={mock()} onAnswer={mock()} /></MemoryRouter>); });
  }
  const text = (className: string) => view!.root.findAll((node) => node.props.className === className).map((node) => textOf(node));
  const textOf = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : textOf(child)).join("");

  // A program can set a terminal title of nothing but spaces; the row had no
  // name, and the pin button was "Pin    " (pre-release bug hunt).
  test("a pane whose title is only spaces is named by its pane id, on the row and aloud", async () => {
    await render([pane({ paneId: "w1:p1", title: "   " })]);
    expect(text("row__title")[0]).toStartWith("w1:p1");
    expect(view!.root.findAll((node) => node.props.className === "pin-button")[0]!.props["aria-label"]).toBe("Pin w1:p1");
  });

  test("the list heading counts one conversation in the singular, and shells as shells", async () => {
    await render([pane({ paneId: "w1:p1", title: "Task" }), pane({ paneId: "w1:p2", isAgent: false, agent: null })]);
    const heading = () => textOf(view!.root.findAll((node) => node.props.className === "group__label")[0]!);
    expect(heading()).toBe("1 agent1");
    await act(async () => view!.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Shells")[0]!.props.onClick());
    expect(heading()).toBe("1 shell1");
  });

  // The waiting card said "untitled" for a pane its row called by its id.
  test("a waiting card with no title is named by its pane id, as its row is", async () => {
    await render([pane({ paneId: "w1:p1", status: "blocked", title: null }), pane({ paneId: "w1:p2", status: "blocked", title: "Fix the build" })]);
    expect(text("blocked__task")).toEqual(["claude · w1:p1", "claude · w1:p2 · Fix the build"]);
  });
});
