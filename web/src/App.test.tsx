import { afterEach, beforeEach, expect, test } from "bun:test";
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
  constructor(readonly url: string) { FakeSocket.made.push(this); }
  send() {}
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
async function render() {
  await act(async () => { view = create(<MemoryRouter><App /></MemoryRouter>); });
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
