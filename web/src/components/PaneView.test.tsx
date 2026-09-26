import { clearWebDrafts, webDraft } from "../drafts";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { forgetEndedConversations } from "../pane-occupants";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ApiContext, ApiError, IncompatibleServerError, UnauthorizedError, api } from "../api";
import { PaneView } from "./PaneView";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let view: ReactTestRenderer | undefined;
let events: EventTarget;
const originals = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
  clearWebDrafts("direct");
  events = new EventTarget();
  for (const [key, value] of Object.entries({ window: events, document: Object.assign(new EventTarget(), { hidden: false }) })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
});
afterEach(async () => {
  if (view) await act(async () => view!.unmount());
  view = undefined;
  // Drafts are module state shared with every other test file in the run.
  clearWebDrafts("direct");
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key];
  }
});
const detail = { pane: { pane_id: "w1:p1", agent_status: "idle" as const, cwd: "/recovered" }, agent: null, layout: null, frame: null };
async function render(pane: typeof api.pane) {
  const scoped = { ...api, pane, sessionLog: mock(() => new Promise<never>(() => {})) };
  await act(async () => { view = create(<ApiContext.Provider value={scoped}><MemoryRouter initialEntries={["/pane/w1:p1"]}><Routes><Route path="/pane/:paneId" element={<PaneView session={null} frames={{}} prompts={{}} onWatch={mock()} onAnswer={mock()} onToast={mock()} />} /></Routes></MemoryRouter></ApiContext.Provider>); });
}
const output = () => JSON.stringify(view!.toJSON());

test("offline pane load stays recoverable and retries when the browser reconnects", async () => {
  const pane = mock().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue(detail);
  await render(pane);
  expect(output()).toContain("Reconnecting");
  expect(output()).not.toContain("This pane is gone");
  await act(async () => { events.dispatchEvent(new Event("online")); });
  expect(pane).toHaveBeenCalledTimes(2);
  expect(output()).toContain("/recovered");
  expect(output()).not.toContain("Reconnecting");
});

test("a transient server failure offers a working manual retry", async () => {
  const pane = mock().mockRejectedValueOnce(new ApiError("unavailable", 503)).mockResolvedValue(detail);
  await render(pane);
  await act(async () => view!.root.findAllByType("button").find(b => b.children.join("") === "Try again")!.props.onClick());
  expect(output()).toContain("/recovered");
  expect(output()).not.toContain("This pane is gone");
});

test("only a confirmed missing pane displays the closed-pane message", async () => {
  await render(mock().mockRejectedValue(new ApiError("no such pane", 404)));
  expect(output()).toContain("This pane is gone");
});

test("an expired session neither claims a closed pane nor rejects unhandled", async () => {
  await render(mock().mockRejectedValue(new UnauthorizedError()));
  expect(output()).toContain("Please reconnect to your computer");
  expect(output()).not.toContain("This pane is gone");
});

test("a computer on another contract version says what to update instead of reconnecting forever", async () => {
  const words = "This app is older than the Shahi on this server. Update the app.";
  const pane = mock().mockRejectedValue(new IncompatibleServerError(words, { min: 6, max: 6 }));
  await render(pane);
  expect(output()).toContain(words);
  expect(output()).not.toContain("Reconnecting");
  await act(async () => { await Bun.sleep(2100); });
  expect(pane).toHaveBeenCalledTimes(1);
});

test("retries after online fires before the relay has recovered", async () => {
  const pane = mock().mockRejectedValueOnce(new TypeError("offline")).mockRejectedValueOnce(new Error("relay reconnecting")).mockResolvedValue(detail);
  await render(pane);
  await act(async () => { events.dispatchEvent(new Event("online")); });
  expect(pane).toHaveBeenCalledTimes(2);
  await act(async () => { await Bun.sleep(2100); });
  expect(pane).toHaveBeenCalledTimes(3);
  expect(output()).toContain("/recovered");
});

test("a send receipt preserves newer draft edits and duplicate taps send only once", async () => {
  let resolve!: (value: unknown) => void;
  const send = mock(() => new Promise<any>(done => { resolve = done; }));
  const scoped = { ...api, send, pane: mock().mockResolvedValue(detail), sessionLog: mock(() => new Promise<never>(() => {})) };
  await act(async () => { view = create(<ApiContext.Provider value={scoped}><MemoryRouter initialEntries={["/pane/w1:p1"]}><Routes><Route path="/pane/:paneId" element={<PaneView session={null} frames={{}} prompts={{}} onWatch={mock()} onAnswer={mock()} onToast={mock()} />} /></Routes></MemoryRouter></ApiContext.Provider>); });
  await act(async () => view!.root.findByType("textarea").props.onChange({ target: { value: "first message" } }));
  const submit = view!.root.findAllByType("button").find(b => b.props.className === "compose__send")!.props.onClick;
  await act(async () => { submit(); submit(); });
  expect(send).toHaveBeenCalledTimes(1);
  await act(async () => view!.root.findByType("textarea").props.onChange({ target: { value: "next message" } }));
  await act(async () => resolve({ accepted: true }));
  expect(view!.root.findByType("textarea").props.value).toBe("next message");
});

test("a send failure arriving after leaving a computer does not show a stale toast", async () => {
  let reject!: (error: Error) => void;
  const send = mock(() => new Promise<any>((_done, fail) => { reject = fail; }));
  const onToast = mock();
  const scoped = { ...api, send, pane: mock().mockResolvedValue(detail), sessionLog: mock(() => new Promise<never>(() => {})) };
  await act(async () => { view = create(<ApiContext.Provider value={scoped}><MemoryRouter initialEntries={["/pane/w1:p1"]}><Routes><Route path="/pane/:paneId" element={<PaneView session={null} frames={{}} prompts={{}} onWatch={mock()} onAnswer={mock()} onToast={onToast} />} /></Routes></MemoryRouter></ApiContext.Provider>); });
  await act(async () => view!.root.findByType("textarea").props.onChange({ target: { value: "first message" } }));
  await act(async () => view!.root.findAllByType("button").find(b => b.props.className === "compose__send")!.props.onClick());
  await act(async () => view!.unmount());
  await act(async () => reject(new Error("old computer offline")));
  expect(onToast).not.toHaveBeenCalled();
});

test("leaving during send and reopening preserves the attempt and follows its receipt", async () => {
  let resolve!: (value: unknown) => void;
  const send = mock(() => new Promise<any>(done => { resolve = done; }));
  const scoped = { ...api, send, pane: mock().mockResolvedValue(detail), sessionLog: mock(() => new Promise<never>(() => {})) };
  const tree = () => <ApiContext.Provider value={scoped}><MemoryRouter initialEntries={["/pane/w1:p1"]}><Routes><Route path="/pane/:paneId" element={<PaneView session={null} frames={{}} prompts={{}} onWatch={mock()} onAnswer={mock()} onToast={mock()} />} /></Routes></MemoryRouter></ApiContext.Provider>;
  await act(async () => { view = create(tree()); });
  await act(async () => view!.root.findByType("textarea").props.onChange({ target: { value: "saved message" } }));
  await act(async () => view!.root.findAllByType("button").find(b => b.props.className === "compose__send")!.props.onClick());
  const attempt = webDraft("direct", "w1:p1").pending?.id;
  await act(async () => view!.unmount());
  await act(async () => { view = create(tree()); });
  expect(view!.root.findByType("textarea").props.value).toBe("saved message");
  expect(view!.root.findAllByType("button").find(b => b.props.className === "compose__send")!.props.disabled).toBe(true);
  expect(webDraft("direct", "w1:p1").pending?.id).toBe(attempt);
  await act(async () => resolve({ accepted: true }));
  expect(view!.root.findByType("textarea").props.value).toBe("");
  expect(webDraft("direct", "w1:p1").pending).toBeNull();
});

test("a reader response from a cleared computer cannot repopulate another computer’s cache", async () => {
  const { Reader, clearReaderMemory } = await import("./Reader");
  clearReaderMemory();
  let resolve!: (value: unknown) => void;
  const old = { ...api, sessionLog: mock(() => new Promise<any>(done => { resolve = done; })) };
  const unavailable = mock();
  await act(async () => { view = create(<ApiContext.Provider value={old}><Reader paneId="same-pane" activity={null} onUnavailable={unavailable} /></ApiContext.Provider>); });
  clearReaderMemory();
  await act(async () => view!.unmount());
  await act(async () => resolve({ messages: [{ id: "private", role: "you", at: 1, blocks: [{ kind: "text", text: "old computer private text" }] }], total: 1, offset: 0 }));
  const next = { ...api, sessionLog: mock(() => new Promise<never>(() => {})) };
  await act(async () => { view = create(<ApiContext.Provider value={next}><Reader paneId="same-pane" activity={null} onUnavailable={unavailable} /></ApiContext.Provider>); });
  expect(output()).not.toContain("old computer private text");
  expect(output()).toContain("Reading the conversation");
  expect(next.sessionLog).toHaveBeenCalledWith("same-pane", { limit: 60 });
});

test("a newly reported pane recovers from an early 404 without polling missing panes forever", async () => {
  const pane = mock().mockRejectedValueOnce(new ApiError("not mirrored yet", 404)).mockResolvedValue(detail);
  const scoped = { ...api, pane, sessionLog: mock(() => new Promise<never>(() => {})) };
  const tree = (present: boolean, title = "New agent") => <ApiContext.Provider value={scoped}><MemoryRouter initialEntries={["/pane/w1:p1"]}><Routes><Route path="/pane/:paneId" element={<PaneView session={{ panes: present ? [{ paneId: "w1:p1", title, isAgent: true, agent: "codex", status: "idle" }] : [] } as any} frames={{}} prompts={{}} onWatch={mock()} onAnswer={mock()} onToast={mock()} />} /></Routes></MemoryRouter></ApiContext.Provider>;
  await act(async () => { view = create(tree(false)); });
  expect(output()).toContain("This pane is gone");
  await act(async () => { await Bun.sleep(2100); });
  expect(pane).toHaveBeenCalledTimes(1);
  await act(async () => view!.update(tree(true)));
  expect(pane).toHaveBeenCalledTimes(2);
  expect(output()).not.toContain("This pane is gone");
  expect(output()).toContain("New agent");
  await act(async () => view!.update(tree(true, "Renamed agent")));
  expect(pane).toHaveBeenCalledTimes(2);
});

// herdr can restore an agent's pane as a plain shell. The composer said "Reply
// to this agent…" over it, and the reply ran as a shell command (pre-release
// bug hunt); the native app already said "Run a command…".
test("a pane that is now a shell asks for a command, not a reply to an agent", async () => {
  const scoped = { ...api, pane: mock().mockResolvedValue(detail), sessionLog: mock(() => new Promise<never>(() => {})) };
  const tree = (isAgent: boolean) => <ApiContext.Provider value={scoped}><MemoryRouter initialEntries={["/pane/w1:p1"]}><Routes><Route path="/pane/:paneId" element={<PaneView session={{ panes: [{ paneId: "w1:p1", title: "zsh", isAgent, agent: null, status: "unknown" }] } as any} frames={{}} prompts={{}} onWatch={mock()} onAnswer={mock()} onToast={mock()} />} /></Routes></MemoryRouter></ApiContext.Provider>;
  await act(async () => { view = create(tree(false)); });
  expect(view!.root.findByType("textarea").props.placeholder).toBe("Run a command…");
  await act(async () => view!.update(tree(true)));
  expect(view!.root.findByType("textarea").props.placeholder).toBe("Reply to this agent…");
});

// herdr reuses pane ids: close the highest space, restart herdr, create one,
// and its panes have the old ids. The pre-release bug hunt kept a draft and an
// uncertain send for w3:p1 in an open page across that: the new program's
// composer showed the old draft, and the retried send ran in the new shell.
describe("a pane id another program has taken", () => {
  const occupied = (instanceId: string, title = "Conversation") =>
    ({ version: "0.9.1", panes: [{ paneId: "w1:p1", instanceId, title, isAgent: true, agent: "claude", status: "idle" }] } as any);
  const tree = (scoped: typeof api, session: any, entry = "/pane/w1:p1") =>
    <ApiContext.Provider value={scoped}><MemoryRouter initialEntries={[entry]}><Routes><Route path="/pane/:paneId" element={<PaneView session={session} frames={{}} prompts={{}} onWatch={mock()} onAnswer={mock()} onToast={mock()} />} /></Routes></MemoryRouter></ApiContext.Provider>;
  const sendButton = () => view!.root.findAllByType("button").find(b => b.props.className === "compose__send")!;

  test("a retried send names the conversation it was typed for, so it cannot land in the next one", async () => {
    const send = mock(() => Promise.reject(new TypeError("response lost")));
    const scoped = { ...api, send, pane: mock().mockResolvedValue(detail), sessionLog: mock(() => new Promise<never>(() => {})) };
    await act(async () => { view = create(tree(scoped, occupied("term_a"))); });
    await act(async () => view!.root.findByType("textarea").props.onChange({ target: { value: "yes, roll it back" } }));
    await act(async () => sendButton().props.onClick());
    await act(async () => sendButton().props.onClick());
    expect(send).toHaveBeenCalledTimes(2);
    const [first, retry] = send.mock.calls as unknown as unknown[][];
    expect(first).toEqual(["w1:p1", "yes, roll it back", expect.any(String), "term_a"]);
    expect(retry).toEqual(first);
  });

  test("the composer drops an unsent draft when another program takes the pane", async () => {
    const send = mock(() => Promise.reject(new TypeError("response lost")));
    const scoped = { ...api, send, pane: mock().mockResolvedValue(detail), sessionLog: mock(() => new Promise<never>(() => {})) };
    const before = occupied("term_a");
    await act(async () => { view = create(tree(scoped, before)); });
    await act(async () => view!.root.findByType("textarea").props.onChange({ target: { value: "A-DRAFT: roll back the payments hotfix on prod" } }));
    await act(async () => sendButton().props.onClick());
    const after = occupied("term_b", "Another conversation");
    // What App does with every session before it renders it.
    await act(async () => { forgetEndedConversations(before, after); view!.update(tree(scoped, after)); });
    expect(view!.root.findByType("textarea").props.value).toBe("");
    expect(webDraft("direct", "w1:p1").pending).toBeNull();
  });

  test("an open reader starts over for the new program, even while its fetches fail", async () => {
    const said = { sessionId: "s-a", path: "/a.jsonl", total: 1, offset: 0, messages: [{ id: "a1", role: "agent", at: 0, blocks: [{ kind: "text", text: "A: shall I roll back prod?" }] }] };
    const sessionLog = mock().mockResolvedValueOnce(said).mockRejectedValue(new ApiError("unavailable", 503));
    const scoped = { ...api, sessionLog, pane: mock().mockResolvedValue(detail) };
    const before = occupied("term_a");
    await act(async () => { view = create(tree(scoped, before)); });
    expect(output()).toContain("A: shall I roll back prod?");
    const after = occupied("term_b", "Another conversation");
    await act(async () => { forgetEndedConversations(before, after); view!.update(tree(scoped, after)); });
    expect(output()).not.toContain("A: shall I roll back prod?");
  });

  test("a notification for a conversation that has ended says so instead of opening the new one", async () => {
    const scoped = { ...api, pane: mock().mockResolvedValue(detail), sessionLog: mock(() => new Promise<never>(() => {})) };
    await act(async () => { view = create(tree(scoped, occupied("term_b", "Another conversation"), "/pane/w1:p1?instance=term_a")); });
    expect(output()).toContain("has ended");
    expect(view!.root.findAllByType("textarea")).toHaveLength(0);
    await act(async () => view!.root.findAllByType("button").find(b => b.children.join("") === "Open what runs there now")!.props.onClick());
    expect(output()).not.toContain("has ended");
    expect(output()).toContain("Another conversation");
  });

  test("while a notification for the conversation still there opens it", async () => {
    const scoped = { ...api, pane: mock().mockResolvedValue(detail), sessionLog: mock(() => new Promise<never>(() => {})) };
    await act(async () => { view = create(tree(scoped, occupied("term_a"), "/pane/w1:p1?instance=term_a")); });
    expect(output()).not.toContain("has ended");
    expect(view!.root.findAllByType("textarea")).toHaveLength(1);
  });
});
