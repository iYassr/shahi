import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { ApiContext, api, type Session } from "../api";
import { NewAgentFlow } from "./NewAgentFlow";
import { LAST_AGENT, NewAgent } from "./NewAgent";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let view: ReactTestRenderer | undefined;
const stored = new Map<string, string>();
const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
beforeAll(() => Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value), removeItem: (key: string) => void stored.delete(key) },
}));
afterAll(() => { if (previous) Object.defineProperty(globalThis, "localStorage", previous); else Reflect.deleteProperty(globalThis, "localStorage"); });
afterEach(async () => { if (view) await act(async () => view!.unmount()); view = undefined; stored.clear(); });

const space = (workspaceId: string, label: string) => ({ workspaceId, label, status: "idle", paneCount: 0, tabCount: 0, focused: false, cwd: `~/${label}`, cwdPath: `/home/me/${label}` });
const session = (...spaces: ReturnType<typeof space>[]) => ({ workspaces: spaces, tabs: [], panes: [] }) as unknown as Session;
const client = {
  ...api,
  dirs: mock(async () => ({ path: "/home/me", display: "~", parent: null, entries: [] })),
  createSpace: mock(async () => ({ workspaceId: "w3" })),
  agents: mock(async () => ({ agents: ["agy", "claude", "codex"].map(kind => ({ kind, command: kind })) })),
  startAgent: mock(async () => ({ paneId: "w3:p1" })),
};
const output = () => JSON.stringify(view!.toJSON());
const button = (label: string) => view!.root.findAll((node) => node.type === "button" && (node.props["aria-label"] === label || node.children.join("") === label))[0]!;
const textOf = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : textOf(child)).join("");
const kinds = () => view!.root.findAll((node) => node.type === "button" && node.props.className === "kind");
const flow = (current: Session, handlers: Partial<Record<"onClose" | "onChanged" | "onStarted", () => void>> = {}) => (
  <ApiContext.Provider value={client}>
    <NewAgentFlow session={current} onToast={mock()} onClose={handlers.onClose ?? mock()} onChanged={handlers.onChanged ?? mock()} onStarted={handlers.onStarted ?? mock()} />
  </ApiContext.Provider>
);

// Simulator run of build 32: with no spaces, New agent opened on "Choose a
// space" with nothing to choose and a button that left for the Spaces tab.
test("with no spaces, New agent starts at the folder, says what a space is, and goes on to the agent", async () => {
  const onChanged = mock();
  await act(async () => { view = create(flow(session(), { onChanged })); });
  expect(output()).not.toContain("Choose a space");
  expect(output()).toContain("a folder on your computer");
  await act(async () => button("Create space and continue").props.onClick());
  expect(client.createSpace).toHaveBeenCalledWith("new space", "/home/me");
  expect(onChanged).toHaveBeenCalledTimes(1);
  expect(output()).toContain("Opening the new space");
  await act(async () => view!.update(flow(session(space("w3", "tip-calc")), { onChanged })));
  expect(output()).toContain("New agent in tip-calc");
});

test("the first space's form has nothing behind it, so closing it closes New agent", async () => {
  const onClose = mock();
  await act(async () => { view = create(flow(session(), { onClose })); });
  await act(async () => button("Close").props.onClick());
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("a space made elsewhere while the first folder is chosen does not swap the form away", async () => {
  await act(async () => { view = create(flow(session())); });
  await act(async () => view!.update(flow(session(space("w1", "elsewhere")))));
  expect(output()).toContain("Create space and continue");
  expect(output()).not.toContain("Choose a space");
});

test("with spaces, a new one is offered above them, and closing it returns to the list", async () => {
  const onClose = mock();
  await act(async () => { view = create(flow(session(space("w1", "projA")), { onClose })); });
  expect(output()).toContain("Choose a space");
  await act(async () => button("+ New space").props.onClick());
  expect(output()).toContain("Create space and continue");
  await act(async () => button("Close").props.onClick());
  expect(onClose).not.toHaveBeenCalled();
  expect(output()).toContain("Choose a space");
  await act(async () => button("projA").props.onClick());
  expect(output()).toContain("New agent in projA");
});

// Simulator run of build 32: the form started on Antigravity, first
// alphabetically, whatever the person used.
test("a new agent starts on Claude when nothing is remembered, not the first agent alphabetically", async () => {
  await act(async () => { view = create(<ApiContext.Provider value={client}><NewAgent space={space("w1", "projA")} onClose={mock()} onToast={mock()} onStarted={mock()} /></ApiContext.Provider>); });
  // Said in words and marked: the check is for the eye, hidden from a screen reader.
  expect(kinds().filter((node) => node.props["aria-pressed"]).map(textOf)).toEqual(["Claude✓"]);
  expect(view!.root.findAll((node) => node.props.className === "kind__check")[0]!.props["aria-hidden"]).toBe("true");
  expect(button("Start Claude")).toBeTruthy();
});

test("the agent last started is chosen, and a start is remembered for the next sheet", async () => {
  stored.set(LAST_AGENT, "codex");
  const onStarted = mock();
  await act(async () => { view = create(<ApiContext.Provider value={client}><NewAgent space={space("w1", "projA")} onClose={mock()} onToast={mock()} onStarted={onStarted} /></ApiContext.Provider>); });
  expect(button("Start Codex")).toBeTruthy();
  await act(async () => kinds().find((node) => textOf(node) === "Antigravity")!.props.onClick());
  await act(async () => button("Start Antigravity").props.onClick());
  expect(onStarted).toHaveBeenCalledWith("w3:p1");
  expect(stored.get(LAST_AGENT)).toBe("agy");
});
