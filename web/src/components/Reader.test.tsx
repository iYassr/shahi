import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { ApiContext, api, type LogMessage, type SessionLog } from "../api";
import { Reader, clearReaderMemory, merge } from "./Reader";

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
