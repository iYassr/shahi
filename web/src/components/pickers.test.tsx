import { afterEach, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { ApiContext, api } from "../api";
import { Attach } from "./Attach";
import { DirPicker } from "./DirPicker";
import { AgentIcon } from "./AgentIcon";

// Component lifecycle tests only: no browser, real connection, or network calls.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let view: ReactTestRenderer;
afterEach(async () => { if (view) await act(async () => view.unmount()); });
const directory = (name: string) => ({ name, path: `/${name}`, display: `/${name}`, isDirectory: true });
const file = (name: string) => ({ ...directory(name), isDirectory: false });
const listing = (entries: any[] = []) => ({ path: "/home", display: "~", parent: "/", entries });
const button = (label: string) => view.root.findAllByType("button").find(b => b.children.join("") === label)!;
const deferred = () => {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>(r => { resolve = r; });
  return { promise, resolve };
};

test("attachment browsing clears old files and offers retry after a folder error", async () => {
  const next = deferred();
  const dirs = mock().mockResolvedValueOnce(listing([directory("folder"), file("old.txt")])).mockImplementationOnce(() => next.promise).mockRejectedValueOnce(new Error("offline")).mockResolvedValue(listing([file("retried.txt")]));
  await act(async () => { view = create(<ApiContext.Provider value={{ ...api, dirs }}><Attach startPath="~" onAttach={mock()} onClose={mock()} onToast={mock()} /></ApiContext.Provider>); });
  await act(async () => button("On your computer").props.onClick());
  const folder = view.root.findAllByType("button").find(b => b.props.className === "picker__row" && b.findAllByType("span").some(s => s.children.includes("folder")))!;
  await act(async () => folder.props.onClick());
  expect(JSON.stringify(view.toJSON())).not.toContain("old.txt");
  await act(async () => next.resolve(listing([directory("deeper")])));
  const deeper = view.root.findAllByType("button").find(b => b.findAllByType("span").some(s => s.children.includes("deeper")))!;
  await act(async () => deeper.props.onClick());
  expect(JSON.stringify(view.toJSON())).toContain("Couldn’t open this folder");
  await act(async () => button("Try again").props.onClick());
  expect(JSON.stringify(view.toJSON())).toContain("retried.txt");
});

test("closing an uploading sheet discards its result and remaining uploads", async () => {
  const pending = deferred();
  const upload = mock(() => pending.promise), onAttach = mock(), onClose = mock();
  await act(async () => { view = create(<ApiContext.Provider value={{ ...api, upload }}><Attach startPath="~" onAttach={onAttach} onClose={onClose} onToast={mock()} /></ApiContext.Provider>); });
  const target = { files: [new File(["one"], "one.txt"), new File(["two"], "two.txt")], value: "chosen" };
  await act(async () => view.root.findAllByType("input")[0]!.props.onChange({ target }));
  expect(target.value).toBe(""); // Choosing the same file after an error fires change again.
  await act(async () => view.unmount());
  await act(async () => pending.resolve({ name: "one.txt", path: "/one.txt", size: 3 }));
  expect(upload).toHaveBeenCalledTimes(1);
  expect(onAttach).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

test("directory selection never offers entries from the previous path while loading", async () => {
  const pending = deferred();
  const dirs = mock().mockResolvedValueOnce(listing([directory("old-folder")])).mockImplementationOnce(() => pending.promise);
  const onChange = mock();
  const render = (path: string) => <ApiContext.Provider value={{ ...api, dirs }}><DirPicker value={{ path, display: path }} onChange={onChange} /></ApiContext.Provider>;
  await act(async () => { view = create(render("/home")); });
  await act(async () => button("Change").props.onClick());
  expect(JSON.stringify(view.toJSON())).toContain("old-folder");
  await act(async () => view.update(render("/other")));
  expect(JSON.stringify(view.toJSON())).not.toContain("old-folder");
  await act(async () => pending.resolve(listing([directory("new-folder")])));
  expect(JSON.stringify(view.toJSON())).toContain("new-folder");
});

test("revoking this browser signs out instead of requesting a now-forbidden device list", async () => {
  const { Settings } = await import("./Settings");
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { matchMedia: () => ({ matches: true }), addEventListener() {}, removeEventListener() {}, confirm: () => true } });
  Object.defineProperty(globalThis, "location", { configurable: true, value: { host: "test.invalid" } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  const devices = mock().mockResolvedValue({ thisDeviceId: "mine", devices: [{ id: "mine", name: "This browser", lastSeenAt: 1 }] });
  const revokeDevice = mock().mockResolvedValue({ ok: true });
  const onLogout = mock();
  try {
    await act(async () => { view = create(<ApiContext.Provider value={{ ...api, devices, revokeDevice }}><Settings onToast={mock()} onLogout={onLogout} /></ApiContext.Provider>); });
    const row = view.root.findAllByType("div").find(n => n.props.className === "device-row")!;
    expect(row.findByType("button").children).toEqual(["Sign out"]);
    await act(async () => row.findByType("button").props.onClick());
    expect(revokeDevice).toHaveBeenCalledWith("mine");
    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(devices).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => view.unmount());
    for (const [key, descriptor] of [["window", originalWindow], ["location", originalLocation], ["navigator", originalNavigator]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key];
    }
  }
});

test("agent creation ignores duplicate taps and dismissal, then opens the returned conversation", async () => {
  const { NewAgent } = await import("./NewAgent");
  const pending = deferred();
  const startAgent = mock(() => pending.promise), onStarted = mock(), onClose = mock();
  const client = { ...api, agents: mock().mockResolvedValue({ agents: [{ kind: "codex", command: "codex" }] }), startAgent };
  await act(async () => { view = create(<ApiContext.Provider value={client}><NewAgent space={{ workspaceId: "wtest", label: "Test", cwd: "~/test", cwdPath: "/home/test" }} onClose={onClose} onToast={mock()} onStarted={onStarted} /></ApiContext.Provider>); });
  const start = button("Start Codex").props.onClick;
  const dismiss = view.root.findAllByType("button").find(b => b.props["aria-label"] === "Close")!.props.onClick;
  await act(async () => { start(); start(); dismiss(); });
  expect(startAgent).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => pending.resolve({ paneId: "wtest:p2" }));
  expect(onStarted).toHaveBeenCalledWith("wtest:p2");
});

test("new agent waits for the home folder to resolve before allowing a start", async () => {
  const { NewAgent } = await import("./NewAgent");
  const pending = deferred();
  const client = { ...api, agents: mock().mockResolvedValue({ agents: [{ kind: "agy", command: "agy" }] }), dirs: mock(() => pending.promise), startAgent: mock() };
  await act(async () => { view = create(<ApiContext.Provider value={client}><NewAgent space={{ workspaceId: "wtest", label: "Test", cwd: null, cwdPath: null }} onClose={mock()} onToast={mock()} onStarted={mock()} /></ApiContext.Provider>); });
  expect(view.root.findByType(AgentIcon).props.kind).toBe("agy");
  expect(button("Start Antigravity").props.disabled).toBe(true);
  await act(async () => button("Start Antigravity").props.onClick());
  expect(client.startAgent).not.toHaveBeenCalled();
  await act(async () => pending.resolve(listing()));
  expect(button("Start Antigravity").props.disabled).toBe(false);
});

test("retrying an uncertain agent start keeps its operation identity", async () => {
  const { NewAgent } = await import("./NewAgent");
  const startAgent = mock().mockRejectedValueOnce(new Error("Connection interrupted")).mockResolvedValueOnce({ paneId: "wtest:p3" });
  const onStarted = mock();
  const client = { ...api, agents: mock().mockResolvedValue({ agents: [{ kind: "codex", command: "codex" }] }), startAgent };
  await act(async () => { view = create(<ApiContext.Provider value={client}><NewAgent space={{ workspaceId: "wtest", label: "Test", cwd: "~/test", cwdPath: "/home/test" }} onClose={mock()} onToast={mock()} onStarted={onStarted} /></ApiContext.Provider>); });
  await act(async () => button("Start Codex").props.onClick());
  await act(async () => button("Start Codex").props.onClick());
  expect(startAgent.mock.calls[0]![6]).toBe(startAgent.mock.calls[1]![6]);
  expect(onStarted).toHaveBeenCalledWith("wtest:p3");
});

test("dashboard uses accessible provider and inbox icons without changing filter identifiers", async () => {
  const { Dashboard } = await import("./Dashboard");
  const { MemoryRouter } = await import("react-router-dom");
  const pane = (agent: string) => ({ paneId: agent, agent, isAgent: true, status: "idle", title: `${agent} task`, workspaceId: "w", workspaceLabel: "Test", tabId: agent, cwd: null, focused: false, hasPrompt: false, prompt: null, preview: null, activity: null });
  const session = { panes: [pane("claude"), pane("codex"), pane("agy")], workspaces: [], defaultGrouping: "priority" } as any;
  await act(async () => { view = create(<MemoryRouter><Dashboard session={session} prompts={{}} reviewed={{}} onReviewed={mock()} onAnswer={mock()} /></MemoryRouter>); });
  const filters = view.root.findAllByType("div").find(n => n.props["aria-label"] === "Filter agents")!;
  const findFilter = (label: string) => filters.findAllByType("button").find(n => n.props["aria-label"] === label)!;
  expect(findFilter("Claude").findByType(AgentIcon).props.kind).toBe("claude");
  expect(findFilter("Codex").findByType(AgentIcon).props.kind).toBe("codex");
  expect(findFilter("Inbox 0").findByType("svg").props["aria-hidden"]).toBe("true");
  await act(async () => findFilter("Antigravity").props.onClick());
  expect(findFilter("Antigravity").props["aria-pressed"]).toBe(true);
  expect(JSON.stringify(view.toJSON())).toContain("agy task");
  expect(JSON.stringify(view.toJSON())).not.toContain("codex task");
});


test("attachment browsing can leave an unavailable workspace folder for home", async () => {
  const dirs = mock().mockRejectedValueOnce(new Error("Outside home directory")).mockResolvedValueOnce(listing([file("report.txt")]));
  const onAttach = mock(), onClose = mock();
  await act(async () => { view = create(<ApiContext.Provider value={{ ...api, dirs }}><Attach startPath="/tmp/workspace" onAttach={onAttach} onClose={onClose} onToast={mock()} /></ApiContext.Provider>); });
  await act(async () => button("On your computer").props.onClick());
  expect(JSON.stringify(view.toJSON())).toContain("Couldn’t open this folder");
  await act(async () => button("Home folder").props.onClick());
  expect(dirs.mock.calls[1]![0]).toBe("~");
  const row = view.root.findAllByType("button").find(b => b.props.className === "picker__row" && b.findAllByType("span").some(s => s.children.includes("report.txt")))!;
  await act(async () => row.props.onClick());
  expect(onAttach).toHaveBeenCalledWith({ name: "report.txt", path: "/report.txt", size: undefined });
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("partial multi-file failure retries only the files that were not attached", async () => {
  const upload = mock().mockResolvedValueOnce({ name: "one.txt", path: "/one.txt", size: 1 }).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ name: "two.txt", path: "/two.txt", size: 1 }).mockResolvedValueOnce({ name: "three.txt", path: "/three.txt", size: 1 });
  const onAttach = mock(), onClose = mock();
  await act(async () => { view = create(<ApiContext.Provider value={{ ...api, upload }}><Attach startPath="~" onAttach={onAttach} onClose={onClose} onToast={mock()} /></ApiContext.Provider>); });
  const files = ["one", "two", "three"].map(name => new File([name], `${name}.txt`));
  await act(async () => view.root.findAllByType("input")[0]!.props.onChange({ target: { files, value: "chosen" } }));
  expect(onAttach).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => button("Retry remaining 2 files").props.onClick());
  expect(upload.mock.calls.map(([file]) => file.name)).toEqual(["one.txt", "two.txt", "two.txt", "three.txt"]);
  expect(onAttach.mock.calls.map(([file]) => file.name)).toEqual(["one.txt", "two.txt", "three.txt"]);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("conversation sidebar follows latest messages, including waiting conversations", async () => {
  const { Dashboard } = await import("./Dashboard");
  const { MemoryRouter } = await import("react-router-dom");
  const pane = (paneId: string, lastMessageAt: number, status: string) => ({ paneId, title: paneId, lastMessageAt, status, agent: "codex", isAgent: true, workspaceId: "w", workspaceLabel: "Test", tabId: paneId, cwd: null, focused: false, hasPrompt: false, prompt: null, preview: null, activity: null });
  let session = { panes: [pane("Old waiting", 10, "blocked"), pane("New reply", 30, "idle"), pane("Working", 20, "working")], workspaces: [], defaultGrouping: "space" } as any;
  const tree = () => <MemoryRouter initialEntries={["/pane/Working"]}><Dashboard session={session} prompts={{}} reviewed={{}} onReviewed={mock()} onAnswer={mock()} /></MemoryRouter>;
  await act(async () => { view = create(tree()); });
  const titles = () => view.root.findAllByType("span").filter(n => n.props.className === "row__title").map(n => n.children[0]);
  expect(titles()).toEqual(["New reply", "Working", "Old waiting"]);
  session = { ...session, panes: session.panes.map((p: any) => p.paneId === "Old waiting" ? { ...p, lastMessageAt: 40 } : p) };
  await act(async () => view.update(tree()));
  expect(titles()).toEqual(["Old waiting", "New reply", "Working"]);
});
