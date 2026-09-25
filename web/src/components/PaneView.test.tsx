import { clearWebDrafts, webDraft } from "../drafts";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
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
