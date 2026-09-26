import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";
import { App } from "./App";

/*
 * The locally served app (direct mode) from its first render: the auth check,
 * the dashboard's live socket and its first snapshot, against a fake server.
 * Nothing here reaches a network.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static made: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: unknown[] = [];
  constructor(readonly url: string) { FakeSocket.made.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
  push(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

/** What the fake server answers, by path; a missing entry never answers. */
let routes: Record<string, () => Response> = {};
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const REFUSAL = "This server runs an older Shahi than the app. Update Shahi on this computer — run herdr plugin install iYassr/shahi again.";
const refused = json({ error: REFUSAL, api: { min: 4, max: 4 } }, 426);

let view: ReactTestRenderer | undefined;
const originals = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
  FakeSocket.made = [];
  routes = {};
  const location = { pathname: "/", protocol: "http:", host: "shahi.test", origin: "http://shahi.test", search: "" };
  for (const [key, value] of Object.entries({
    window: Object.assign(new EventTarget(), { location, matchMedia: () => ({ matches: false }) }),
    document: Object.assign(new EventTarget(), { visibilityState: "visible", hidden: false, querySelector: () => null, querySelectorAll: () => [] }),
    navigator: { onLine: true, userAgent: "test", platform: "test", maxTouchPoints: 0 },
    location,
    WebSocket: FakeSocket,
    fetch: (input: string) => { const answer = routes[new URL(input, location.origin).pathname]; return answer ? Promise.resolve(answer()) : new Promise(() => {}); },
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
});
afterEach(async () => {
  if (view) await act(async () => view!.unmount());
  view = undefined;
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key];
  }
});
const text = () => JSON.stringify(view!.toJSON());
const settle = () => act(async () => { for (let i = 0; i < 10; i++) await Bun.sleep(0); });
async function render(path = "/") {
  await act(async () => { view = create(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>); });
  await settle();
}

test("a slow first answer shows Shahi opening instead of an empty page", async () => {
  // A half-open SSH tunnel after the laptop slept: the auth check hangs until
  // its fifteen-second deadline, and nothing at all was drawn meanwhile.
  await render();
  expect(view!.toJSON()).not.toBeNull();
  expect(text()).toContain("Opening Shahi…");
});

test("a computer on another contract version says which side to update instead of reconnecting", async () => {
  routes["/api/auth/status"] = json({ required: false, authenticated: true });
  routes["/api/session"] = refused;
  routes["/api/meta"] = refused;
  await render();
  expect(text()).toContain("Update needed");
  expect(text()).toContain("run herdr plugin install iYassr/shahi again");
  expect(text()).not.toContain("need to pair again");
});

test("the update notice survives a dashboard push and stops the live stream", async () => {
  routes["/api/auth/status"] = json({ required: false, authenticated: true });
  routes["/api/meta"] = refused;
  // The first snapshot is answered by hand, so a push can land right behind it.
  let answer!: (response: Response) => void;
  const snapshot = new Promise<Response>(done => { answer = done; });
  const routed = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: (input: string) => input === "/api/session" ? snapshot : routed(input) });
  await render();
  const stream = FakeSocket.made[0]!;
  await act(async () => {
    stream.readyState = 1; stream.onopen?.();
    answer(refused());
    for (let i = 0; i < 5; i++) await Bun.sleep(0);
    stream.push({ type: "session", session: { panes: [], workspaces: [] } });
  });
  await settle();
  expect(text()).toContain("Update needed");
  // A stream in a shape this build may misread is not kept open, or reopened.
  expect(FakeSocket.made.every(socket => socket.readyState === 3)).toBe(true);
  expect(FakeSocket.made).toHaveLength(1);
});

// Pre-release bug hunt, B43: herdr gives a closed space's id to the next space
// after a restart. A New agent sheet left open for the closed one reopened by
// itself for the new one, ready to start there.
test("a New agent sheet whose space closed goes back to choosing a space, not to the next space with its id", async () => {
  const { SHAHI_API_VERSION } = await import("@shahi/shared");
  const session = (...labels: string[]) => ({
    panes: [],
    tabs: [],
    workspaces: labels.map((label) => ({ workspaceId: "w9", label, status: "idle", paneCount: 1, tabCount: 1, focused: false, cwd: `~/${label}`, cwdPath: `/home/me/${label}` })),
  });
  routes["/api/auth/status"] = json({ required: false, authenticated: true });
  routes["/api/meta"] = json({ serverId: "test", api: { min: SHAHI_API_VERSION, max: SHAHI_API_VERSION } });
  routes["/api/session"] = json(session("projA"));
  routes["/api/agents"] = json({ agents: [], known: 0 });
  await render();
  const stream = FakeSocket.made[0]!;
  await act(async () => { stream.readyState = 1; stream.onopen?.(); });
  await settle();
  const button = (label: string) => view!.root.findAll((node) => node.type === "button" && node.children.join("") === label)[0]!;
  await act(async () => button("+ New agent").props.onClick());
  await act(async () => button("projA").props.onClick());
  expect(text()).toContain("New agent in projA");

  await act(async () => stream.push({ type: "session", session: session() }));
  await settle();
  expect(text()).toContain("Choose a space");
  await act(async () => stream.push({ type: "session", session: session("projB") }));
  await settle();
  expect(text()).not.toContain("New agent in");
  expect(text()).toContain("Choose a space");
});

test("a pane opened by its address is watched once the live stream opens", async () => {
  // A reload, a bookmark or a notification mounts the pane in the same commit
  // as the socket, and the pane asked to watch before the socket existed: the
  // Screen tab froze on its first frame and an answered card stayed up.
  routes["/api/auth/status"] = json({ required: false, authenticated: true });
  routes["/api/session"] = json({ panes: [], workspaces: [], tabs: [] });
  await render("/pane/w1%3Ap1");
  const stream = FakeSocket.made[0]!;
  await act(async () => { stream.readyState = 1; stream.onopen?.(); });
  expect(stream.sent).toContainEqual({ type: "watch", paneId: "w1:p1" });
});

describe("launched while the computer is away", () => {
  // "Cannot reach Shahi" said Shahi was reconnecting and then asked nothing:
  // no request in 45 seconds or after the page was shown again, until
  // someone pressed Try again (pre-release bug hunt).
  let away = true;
  beforeEach(() => {
    away = true;
    routes["/api/auth/status"] = () => {
      if (away) throw new TypeError("Load failed");
      return json({ required: false, authenticated: true })();
    };
    routes["/api/session"] = json({ panes: [], workspaces: [], tabs: [] });
  });

  test("says what to check rather than that a conversation is reconnecting", async () => {
    await render();
    expect(text()).toContain("Cannot reach Shahi");
    expect(text()).toContain("Check that your computer is awake and Shahi is running");
    expect(text()).not.toContain("Your conversation stays open");
    expect(text()).not.toContain("pair again");
  });

  test("asks again when the page is shown", async () => {
    await render();
    expect(text()).toContain("Cannot reach Shahi");
    away = false;
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    expect(text()).not.toContain("Cannot reach Shahi");
  });

  test("asks again by itself after a short wait", async () => {
    // Fake timers stop `settle`'s sleeps too, so only promise jobs are run.
    const flush = () => act(async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); });
    jest.useFakeTimers();
    try {
      await act(async () => { view = create(<MemoryRouter><App /></MemoryRouter>); });
      await flush();
      expect(text()).toContain("Cannot reach Shahi");
      away = false;
      await act(async () => { jest.advanceTimersByTime(1_999); });
      await flush();
      expect(text()).toContain("Cannot reach Shahi");
      await act(async () => { jest.advanceTimersByTime(1); });
      await flush();
      expect(text()).not.toContain("Cannot reach Shahi");
    } finally { jest.useRealTimers(); }
  });
});

const ask = (question: string) => ({
  question, answer: "digit", options: [{ index: 1, label: "Yes", selected: true }, { index: 2, label: "No", selected: false }],
});
const waiting = (prompt: unknown) => ({
  panes: [{ paneId: "w1:p1", workspaceId: "w1", workspaceLabel: "one", tabId: "t1", status: "blocked", agent: "claude", title: "task", cwd: null, focused: false, hasPrompt: !!prompt, isAgent: true, prompt, preview: null, activity: null }],
  workspaces: [], tabs: [],
});
/** The live stream, open, with the session it would carry. */
async function liveWith(session: unknown) {
  routes["/api/auth/status"] = json({ required: false, authenticated: true });
  routes["/api/session"] = json(session);
  await render();
  const stream = FakeSocket.made[0]!;
  await act(async () => { stream.readyState = 1; stream.onopen?.(); });
  await settle();
  return stream;
}

// A phone slept through question B while A was answered at the laptop. The
// snapshot said B; the card kept A, and every tap on it was refused.
test("a waiting card follows the snapshot's question, not one pushed before a disconnect", async () => {
  const stream = await liveWith(waiting(ask("Run the migration?")));
  await act(async () => { stream.push({ type: "prompt", paneId: "w1:p1", prompt: ask("Run the migration?") }); });
  await act(async () => { stream.push({ type: "session", session: waiting(ask("Delete the old table?")) }); });
  await settle();
  expect(text()).toContain("Delete the old table?");
  expect(text()).not.toContain("Run the migration?");
});

// Answered elsewhere first: the server refused the stale tap with 409, the
// toast read "w1:p1 is not asking anything now" and every option came back.
test("a tap on a question that already closed stops offering it instead of re-arming its options", async () => {
  await liveWith(waiting(ask("Run the migration?")));
  routes["/api/panes/w1%3Ap1/answer"] = json({ error: "That question has already been answered or closed. Nothing was sent.", code: "prompt_gone" }, 409);
  const yes = view!.root.findAll((node) => node.type === "button" && node.props.className === "choice")[0]!;
  await act(async () => { yes.props.onClick(); });
  await settle();
  expect(view!.root.findAll((node) => node.type === "button" && node.props.className === "choice")).toHaveLength(0);
  expect(text()).toContain("That question had already closed, so nothing was sent.");
  expect(text()).not.toContain("needs a typed reply");
});
