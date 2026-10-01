import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { ApiContext, api, type LogMessage, type SessionLog } from "../api";
import { Reader, clearReaderMemory, merge } from "./Reader";
import { providerReaderFixtures } from "../../../shared/test-fixtures/provider-reader";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const message = (id: string, text = "hello"): LogMessage => ({
  id,
  role: "agent",
  at: 0,
  blocks: [{ kind: "text", text }],
});

describe("merge", () => {
  test("takes the page when nothing is on screen yet", () => {
    const page = [message("a"), message("b")];
    expect(merge([], page)).toEqual(page);
  });

  test("keeps messages older than the page", () => {
    // The shape that was broken: "Load earlier" fetched these, and the next
    // poll — which only ever sees the newest page — threw them away.
    const older = [message("older-1"), message("older-2")];
    const page = [message("b"), message("c")];
    expect(merge([...older, ...page], page).map((m) => m.id)).toEqual([
      "older-1",
      "older-2",
      "b",
      "c",
    ]);
  });

  test("prefers the page's version of a message still being written", () => {
    const merged = merge([message("a", "partial")], [message("a", "partial and then some")]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.blocks[0]).toEqual({ kind: "text", text: "partial and then some" });
  });

  test("appends messages that arrived since the last poll", () => {
    expect(merge([message("a")], [message("a"), message("b")]).map((m) => m.id)).toEqual(["a", "b"]);
  });
});

describe("reader update identity", () => {
  test("an unchanged tail retains the loaded array and all message objects", () => {
    const current = [message("old"), message("a"), message("b")];
    expect(merge(current, [message("a"), message("b")])).toBe(current);
  });
  test("a same-length text edit updates only the edited message", () => {
    const current = [message("old"), message("a", "hello")];
    const next = merge(current, [message("a", "world")]);
    expect(next[0]).toBe(current[0]);
    expect(next[1]).not.toBe(current[1]);
    expect(next[1]!.blocks).toEqual([{ kind: "text", text: "world" }]);
  });
  test("tool results arriving invalidate the message", () => {
    const current: LogMessage[] = [{ ...message("a"), blocks: [{ kind: "tool", name: "Bash", summary: "ls", result: null }] }];
    const finished: LogMessage = { ...message("a"), blocks: [{ kind: "tool", name: "Bash", summary: "ls", result: { text: "file", isError: false, truncated: false, images: [] } }] };
    expect(merge(current, [finished])[0]).toBe(finished);
  });
});

describe("a pane reused by a new session", () => {
  // Cursor numbers messages from `cursor-0` in every transcript, so a new chat
  // in the same pane reuses the old chat's ids. Merged by id, the reader kept
  // the old conversation on screen with the new one appended beneath it.
  const said = (id: string, text: string): LogMessage => ({ ...message(id, text), role: id.endsWith("0") ? "you" : "agent" });
  const log = (sessionId: string, messages: LogMessage[], total = messages.length): SessionLog => ({
    sessionId, path: `/home/me/.cursor/projects/p/agent-transcripts/${sessionId}.jsonl`, messages, total, offset: 0,
  });
  // Longer than the new chat, as the old one usually is: its last id is one the
  // new page never mentions, which is what the merge used to keep.
  const oldChat = log("chat-old", [said("cursor-0", "OLD secret question"), said("cursor-1", "OLD reply 1"), said("cursor-2", "OLD follow-up"), said("cursor-3", "OLD reply 2")]);
  const newChat = log("chat-new", [said("cursor-0", "NEW question"), said("cursor-1", "NEW answer"), said("cursor-2", "NEW follow-up")]);

  let view: ReactTestRenderer | undefined;
  let events: EventTarget;
  const originals = new Map<string, PropertyDescriptor | undefined>();
  beforeEach(() => {
    clearReaderMemory();
    events = new EventTarget();
    for (const [key, value] of Object.entries({ window: events, document: Object.assign(new EventTarget(), { hidden: false }) })) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
  });
  afterEach(async () => {
    if (view) await act(async () => view!.unmount());
    view = undefined;
    clearReaderMemory();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key];
    }
  });
  const output = () => JSON.stringify(view!.toJSON());
  const render = (sessionLog: typeof api.sessionLog) => act(async () => {
    view = create(<ApiContext.Provider value={{ ...api, sessionLog }}><Reader paneId="w1:p1" activity={null} onUnavailable={() => {}} /></ApiContext.Provider>);
  });
  const logChanged = () => act(async () => { events.dispatchEvent(new CustomEvent("shahi:log_changed", { detail: "w1:p1" })); });

  test("an open reader shows only the new session's messages when the pane starts another chat", async () => {
    await render(mock().mockResolvedValueOnce(oldChat).mockResolvedValue(newChat));
    expect(output()).toContain("OLD secret question");
    await logChanged();
    expect(output()).toContain("NEW question");
    expect(output()).toContain("NEW follow-up");
    expect(output()).not.toContain("OLD");
  });

  test("reopening a pane remembered from the previous session does not carry it into the new one", async () => {
    await render(mock().mockResolvedValue(oldChat));
    await act(async () => view!.unmount());
    await render(mock().mockResolvedValue(newChat));
    expect(output()).toContain("NEW answer");
    expect(output()).not.toContain("OLD");
  });

  test("activity disclosure resets when a new transcript reuses message ids", async () => {
    const work: LogMessage = { id: "reused", role: "agent", at: 1, blocks: [{ kind: "tool", name: "Bash", summary: "Check project", result: null }] };
    let current = log("old", [work]);
    await render(async () => current);
    const drawer = () => view!.root.findByProps({ className: "reader-activity__head" });
    await act(async () => drawer().props.onClick());
    expect(drawer().props["aria-expanded"]).toBe(true);
    current = log("new", [work]);
    await logChanged();
    expect(drawer().props["aria-expanded"]).toBe(false);
    expect(view!.root.findAllByProps({ className: "tool__head" })).toHaveLength(0);
  });

  test("working activity collapses when finished but can be reopened", async () => {
    const work: LogMessage = { id: "step", role: "agent", at: 1, blocks: [{ kind: "tool", name: "Read", summary: "Check project", result: null }] };
    const sessionLog = async () => log("same", [work]);
    const draw = (activity: { verb: string; elapsed: string; detail: string } | null) =>
      <ApiContext.Provider value={{ ...api, sessionLog }}><Reader paneId="w1:p1" activity={activity} onUnavailable={() => {}} /></ApiContext.Provider>;
    await act(async () => { view = create(draw({ verb: "Working", elapsed: "1s", detail: "" })); });
    const drawer = () => view!.root.findByProps({ className: "reader-activity__head" });
    expect(output()).toContain("Reading files… · 1 step");
    expect(view!.root.findAllByProps({ className: "working" })).toHaveLength(0);
    await act(async () => drawer().props.onClick());
    expect(drawer().props["aria-expanded"]).toBe(true);
    await act(async () => view!.update(draw(null)));
    expect(drawer().props["aria-expanded"]).toBe(false);
    await act(async () => drawer().props.onClick());
    expect(drawer().props["aria-expanded"]).toBe(true);
  });

  test("a history page from the previous session is not prepended to the new one", async () => {
    let olderReply!: (value: SessionLog) => void;
    let polls = 0;
    const sessionLog = mock((_pane: string, options: { before?: number } = {}) => options.before !== undefined
      ? new Promise<SessionLog>(done => { olderReply = done; })
      : Promise.resolve(++polls === 1 ? log("chat-old", oldChat.messages, 90) : newChat));
    await render(sessionLog);
    await act(async () => view!.root.findAllByType("button").find(b => b.props.className === "reader__more")!.props.onClick());
    await logChanged();
    await act(async () => olderReply(log("chat-old", [said("cursor-9", "OLD earlier history")], 90)));
    expect(output()).not.toContain("OLD");
    expect(output()).toContain("NEW follow-up");
  });

  for (const fixture of providerReaderFixtures) {
    test(`${fixture.label} pages expose authored messages, thinking, editable files, questions and tool outcomes`, async () => {
      await render(mock().mockResolvedValue(fixture.log));
      expect(output()).toContain("Read the sample and change it to ready.");
      expect(output()).toContain("The sample is ready.");
      expect(output()).toContain(fixture.question);
      expect(output()).toContain("Keep reviewing");
      expect(output()).not.toContain("Internal only");
      expect(view!.root.findAllByProps({ className: "msg__thinking" })).toHaveLength(0);
      expect(view!.root.findByProps({ className: "reader-activity__head" }).props['aria-expanded']).toBe(false);
      expect(view!.root.findByProps({ className: "tool__open" }).children).toEqual(["status.txt"]);
      await act(async () => view!.root.findByProps({ className: "reader-activity__head" }).props.onClick());
      expect(view!.root.findByProps({ className: "msg__thinking" }).findByType("p").children).toEqual([fixture.thinking]);
      expect(view!.root.findByProps({ className: "tool__open" }).children).toEqual(["status.txt"]);
      const head = (summary: string) => view!.root.findAllByProps({ className: "tool__head" }).find(button => button.findByProps({ className: "tool__summary" }).children.join("") === summary)!;
      expect(output()).not.toContain(fixture.error);
      await act(async () => head(fixture.command).props.onClick());
      expect(view!.root.findAllByProps({ className: "tool__out" }).some(node => JSON.stringify(node.children).includes(fixture.output))).toBe(true);
      await act(async () => head(fixture.deniedCommand).props.onClick());
      expect(output()).toContain(fixture.error);
      expect(head(fixture.deniedCommand).findByProps({ className: "tool__err" }).children).toEqual(["failed"]);
      expect(output()).not.toContain("Still running.");
    });
  }

  for (const provider of ["OpenCode undo", "Cursor rewrite"]) {
    test(`${provider} changes the path in the same session, clearing retained history and a late earlier page`, async () => {
      const base = provider === "OpenCode undo" ? "/data/opencode.db#ses_same" : "/data/cursor/store.db#same";
      const first: SessionLog = { ...oldChat, sessionId: "same", path: base, total: 6, messages: oldChat.messages.slice(2) };
      const replacement: SessionLog = { ...newChat, sessionId: "same", path: `${base}:rewritten`, total: 1, messages: [said("cursor-2", "NEW retained turn")] };
      let current = first;
      let earlierCalls = 0;
      let late!: (value: SessionLog) => void;
      const sessionLog = mock((_pane: string, options: { before?: number } = {}) => options.before === undefined ? Promise.resolve(current)
        : ++earlierCalls === 1 ? Promise.resolve({ ...first, messages: oldChat.messages.slice(0, 2) })
        : new Promise<SessionLog>(resolve => { late = resolve; }));
      const more = () => view!.root.findByProps({ className: "reader__more" });
      await render(sessionLog);
      await act(async () => more().props.onClick());
      expect(output()).toContain("OLD secret question");
      // Another pagination request is still in flight when the provider rewrites.
      await act(async () => { void more().props.onClick(); });
      current = replacement;
      await logChanged();
      expect(output()).toContain("NEW retained turn");
      expect(output()).not.toContain("OLD");
      expect(output()).not.toContain("Load earlier");
      await act(async () => late({ ...first, messages: [said("cursor-old", "OLD late history")] }));
      expect(output()).not.toContain("OLD");
      // The stale page must not reappear from remembered history on next open.
      await act(async () => view!.unmount());
      await render(mock().mockRejectedValue(new Error("offline")));
      expect(output()).toContain("NEW retained turn");
      expect(output()).not.toContain("OLD");
    });
  }

});

describe("more messages than a poll's tail", () => {
  // Twelve or more messages between two polls — a burst, or a tab left hidden
  // while an agent worked — used to reset the reader to the newest twelve,
  // throwing away "Load earlier" and the message being read (pre-release bug
  // hunt).
  const said = (id: string, text: string): LogMessage => message(id, text);
  const transcript: LogMessage[] = [];
  const sessionLog = mock((_pane: string, options: { limit?: number; before?: number } = {}): Promise<SessionLog> => {
    const end = options.before ?? transcript.length;
    const messages = transcript.slice(Math.max(0, end - (options.limit ?? 60)), end);
    return Promise.resolve({ sessionId: "chat", path: "/home/me/.claude/projects/p/chat.jsonl", messages, total: transcript.length, offset: 0 });
  });

  let view: ReactTestRenderer | undefined;
  let events: EventTarget;
  let page: EventTarget & { hidden: boolean };
  const originals = new Map<string, PropertyDescriptor | undefined>();
  beforeEach(() => {
    clearReaderMemory();
    transcript.splice(0, transcript.length, ...Array.from({ length: 200 }, (_, i) => said(`m-${i}`, `message ${i}.`)));
    events = new EventTarget();
    page = Object.assign(new EventTarget(), { hidden: false });
    for (const [key, value] of Object.entries({ window: events, document: page })) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
  });
  afterEach(async () => {
    if (view) await act(async () => view!.unmount());
    view = undefined;
    clearReaderMemory();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key];
    }
  });
  const output = () => JSON.stringify(view!.toJSON());
  const open = async () => {
    await act(async () => {
      view = create(<ApiContext.Provider value={{ ...api, sessionLog }}><Reader paneId="w1:p1" activity={null} onUnavailable={() => {}} /></ApiContext.Provider>);
    });
    await act(async () => view!.root.findAllByType("button").find(b => b.props.className === "reader__more")!.props.onClick());
    expect(output()).toContain("message 80.");
  };
  const arrive = (count: number) => transcript.push(...Array.from({ length: count }, (_, i) => said(`n-${i}`, `new ${i}.`)));
  const expectAllOf = (count: number) => {
    expect(output()).toContain("message 80.");
    expect(output()).toContain("message 199.");
    expect(output()).toContain("new 0.");
    expect(output()).toContain(`new ${count - 1}.`);
    expect(output()).toContain("Load earlier (80 more)");
  };

  test("a burst of new messages keeps the loaded history", async () => {
    await open();
    arrive(20);
    await act(async () => { events.dispatchEvent(new CustomEvent("shahi:log_changed", { detail: "w1:p1" })); });
    expectAllOf(20);
  });

  test("messages that arrived while the tab was hidden join the loaded history", async () => {
    await open();
    page.hidden = true;
    arrive(15);
    await act(async () => { events.dispatchEvent(new CustomEvent("shahi:log_changed", { detail: "w1:p1" })); });
    expect(output()).not.toContain("new 0.");
    page.hidden = false;
    await act(async () => { page.dispatchEvent(new Event("visibilitychange")); });
    expectAllOf(15);
  });
});

// Device report, October 2026: the reader showed neither Claude's task list
// nor its subagents, which sat as one more collapsed step of activity.
describe("tasks and subagents", () => {
  let view: ReactTestRenderer | undefined;
  let events: EventTarget;
  const originals = new Map<string, PropertyDescriptor | undefined>();
  beforeEach(() => {
    clearReaderMemory();
    events = new EventTarget();
    for (const [key, value] of Object.entries({ window: events, document: Object.assign(new EventTarget(), { hidden: false }) })) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
  });
  afterEach(async () => {
    if (view) await act(async () => view!.unmount());
    view = undefined;
    clearReaderMemory();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key];
    }
  });
  const render = (sessionLog: typeof api.sessionLog) => act(async () => {
    view = create(<ApiContext.Provider value={{ ...api, sessionLog }}><Reader paneId="w1:p1" activity={null} onUnavailable={() => {}} /></ApiContext.Provider>);
  });
  const logChanged = () => act(async () => { events.dispatchEvent(new CustomEvent("shahi:log_changed", { detail: "w1:p1" })); });
  const log = (messages: LogMessage[], extra: Partial<SessionLog> = {}): SessionLog => ({
    sessionId: "s1", path: "/home/me/.claude/projects/p/s1.jsonl", messages, total: messages.length, offset: 0, ...extra,
  });
  const call: LogMessage = { id: "a1", role: "agent", at: 1, blocks: [{
    kind: "tool", name: "Agent", summary: "Survey the fixtures",
    subagent: { id: "toolu_1", description: "Survey the fixtures", type: "Explore", background: true },
    result: { text: "Started in the background.", isError: false, truncated: false, images: [] },
  }] };
  const report = (status: string): LogMessage => ({ id: "s1", role: "system", at: 2, blocks: [{
    kind: "text", text: `Agent "Survey the fixtures" finished (${status})\nFound three fixtures.`, notice: { toolUseId: "toolu_1", status },
  }] });
  const head = () => view!.root.findByProps({ className: "subagent__head" });

  test("a background subagent is its own row, running until its report arrives, then done with it", async () => {
    let current = log([call]);
    await render(async () => current);
    expect(head().props["aria-label"]).toBe("Subagent, Survey the fixtures, Explore, Running…");
    expect(view!.root.findAllByProps({ className: "reader-activity__head" })).toHaveLength(0);
    current = log([call, report("completed")]);
    await logChanged();
    expect(head().props["aria-label"]).toBe("Subagent, Survey the fixtures, Explore, Done");
    const shown = JSON.stringify(view!.toJSON());
    expect(shown).toContain("Found three fixtures.");
    // Folded into the row, not repeated as a system note.
    expect(shown).not.toContain("System");
    expect(head().props["aria-expanded"]).toBe(false);
    await act(async () => head().props.onClick());
    expect(head().props["aria-expanded"]).toBe(true);
  });

  test("a stopped background subagent says so", async () => {
    await render(async () => log([call, report("killed")]));
    expect(head().props["aria-label"]).toBe("Subagent, Survey the fixtures, Explore, Stopped");
  });

  test("the task list sits at the end, counted like Claude Code's, with the task under way showing", async () => {
    await render(async () => log([message("m1", "Working through it.")], { tasks: [
      { id: "1", subject: "Read the census", status: "completed" },
      { id: "2", subject: "Write the reader", status: "in_progress", activeForm: "Writing the reader" },
      { id: "3", subject: "Ship it", status: "pending" },
    ] }));
    const tasksHead = () => view!.root.findByProps({ className: "tasks__head" });
    const texts = () => view!.root.findAllByProps({ className: "tasks__text" }).map(node => node.children.join(""));
    expect(JSON.stringify(tasksHead().children.map(child => typeof child === "string" ? child : child.children))).toContain("3 tasks (1 done, 1 in progress, 1 open)");
    expect(texts()).toEqual(["Writing the reader"]);
    await act(async () => tasksHead().props.onClick());
    expect(texts()).toEqual(["Read the census", "Write the reader", "Ship it"]);
  });

  test("no tasks, no card", async () => {
    await render(async () => log([message("m1", "Done.")]));
    expect(view!.root.findAllByProps({ className: "tasks" })).toHaveLength(0);
  });
});
