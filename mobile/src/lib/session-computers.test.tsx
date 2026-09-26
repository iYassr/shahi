import { act, render, waitFor } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { SessionProvider, useSession } from "./session";
import { api, ApiError, connection, IncompatibleServerError, UnauthorizedError } from "./api";
import { COMPUTERS_KEY, computerId, type ComputerConnection } from "./computers";
import { openTunnel } from "./tunnel";
import { AppState } from "react-native";
import { addNetworkStateListener, getNetworkStateAsync } from "expo-network";
import { RelayLink } from "./relay";

const mockSockets: any[] = [];
jest.mock("./tunnel", () => ({ openTunnel: jest.fn(), closeTunnel: jest.fn(async () => {}), forgetHostKey: jest.fn(async () => {}) }));
jest.mock("./push-registration", () => ({ configurePushComputer: jest.fn(), forgetPushRegistration: jest.fn(), renewPushRegistration: jest.fn(async () => {}) }));
jest.mock("./api", () => ({ ...jest.requireActual("./api"),
  createApi: () => require("./api").api,
  api: { session: jest.fn(), login: jest.fn(async () => {}) },
  SessionSocket: class {
    close = jest.fn(); connect = jest.fn(); watch = jest.fn(); ensureConnected = jest.fn();
    message: any; state: any; unauthorized: any;
    constructor(message: any, state: any, unauthorized: any) { this.message = message; this.state = state; this.unauthorized = unauthorized; mockSockets.push(this); }
  },
}));
let value: ReturnType<typeof useSession>;
function Probe() { value = useSession(); return null; }
const a = { kind: "relay", relay: "wss://relay.test", serverId: "computer-a", deviceId: "phone-a", deviceSecret: "secret-a" } satisfies ComputerConnection;
const b = { ...a, serverId: "computer-b", deviceId: "phone-b", deviceSecret: "secret-b" };
// The panes the pin tests pin: a pin is shown, and kept, only while its pane
// is in the computer's session (herdr reuses pane ids).
const snapshot = { panes: [{ paneId: "a-pin", status: "idle" }, { paneId: "same-pane-id", status: "idle" }], tabs: [], workspaces: [], version: "test", protocol: 22 };
const store = new Map<string, string>();
const bank = () => JSON.parse(store.get(COMPUTERS_KEY)!);
async function mount() {
  const ui = render(<SessionProvider><Probe /></SessionProvider>);
  await waitFor(() => expect(value.ready).toBe(true));
  return ui;
}
async function pairBoth() {
  act(() => value.signInRelay(a));
  await act(async () => { await value.addComputer(); });
  act(() => value.signInRelay(b));
  await act(async () => {});
}
beforeEach(() => {
  jest.clearAllMocks(); store.clear(); mockSockets.length = 0;
  connection.relay = null; connection.cookie = null;
  (SecureStore.getItemAsync as jest.Mock).mockImplementation(async (key) => store.get(key) ?? null);
  (SecureStore.setItemAsync as jest.Mock).mockImplementation(async (key, data) => { store.set(key, data); });
  (SecureStore.deleteItemAsync as jest.Mock).mockImplementation(async (key) => { store.delete(key); });
  (api.session as jest.Mock).mockResolvedValue(snapshot);
});
test("two computers on the same relay survive switching both ways and a cold launch", async () => {
  let ui = await mount(); await pairBoth();
  expect(value.computers).toHaveLength(2);
  expect(JSON.stringify(value.computers)).not.toContain("secret-");
  await act(async () => { await value.switchComputer(computerId(a)); });
  expect(connection.relay?.serverId).toBe(a.serverId);
  await act(async () => { await value.switchComputer(computerId(b)); });
  expect(connection.relay?.serverId).toBe(b.serverId);
  expect(bank()).toHaveLength(2);
  ui.unmount(); ui = await mount();
  expect(value.activeComputerId).toBe(computerId(b));
  expect(value.computers).toHaveLength(2);
  await act(async () => { await value.switchComputer(computerId(a)); });
  expect(connection.relay?.serverId).toBe(a.serverId);
  ui.unmount();
});
// Restoring the selected computer on launch moved it to the end of the list,
// so a, b, c with a selected came back b, c, a (pre-release bug hunt).
test("the saved computer list keeps its order across cold launches", async () => {
  const c = { ...a, serverId: "computer-c", deviceId: "phone-c", deviceSecret: "secret-c" };
  let ui = await mount(); await pairBoth();
  await act(async () => { await value.addComputer(); });
  act(() => value.signInRelay(c));
  await act(async () => {});
  await act(async () => { await value.switchComputer(computerId(a)); });
  const order = [computerId(a), computerId(b), computerId(c)];
  expect(value.computers.map(computer => computer.id)).toEqual(order);
  for (let launch = 0; launch < 2; launch++) {
    ui.unmount(); ui = await mount();
    expect(value.activeComputerId).toBe(computerId(a));
    expect(value.computers.map(computer => computer.id)).toEqual(order);
    await act(async () => { await value.switchComputer(computerId(a)); });
    expect(bank().map((computer: { id: string }) => computer.id)).toEqual(order);
  }
  ui.unmount();
});
test("pins and late socket or HTTP replies cannot cross computers", async () => {
  const ui = await mount(); await pairBoth();
  act(() => value.togglePin("same-pane-id"));
  const oldSocket = mockSockets.at(-1);
  let reject!: (error: Error) => void;
  (api.session as jest.Mock).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  let pending!: Promise<void>;
  act(() => { pending = value.refresh(); });
  await act(async () => { await value.switchComputer(computerId(a)); });
  expect(value.pins.size).toBe(0);
  await act(async () => {
    oldSocket.message({ type: "session", session: { ...snapshot, serverName: "wrong computer" } });
    oldSocket.unauthorized(); reject(new UnauthorizedError()); await pending;
  });
  expect(value.connected).toBe(true);
  expect(value.session?.serverName).not.toBe("wrong computer");
  expect(value.computers.map(c => c.id)).toEqual([computerId(a)]);
  ui.unmount();
});
test("sign out forgets only the current computer", async () => {
  const ui = await mount(); await pairBoth();
  await act(async () => { value.signOut(); });
  expect(value.computers.map(c => c.id)).toEqual([computerId(a)]);
  expect(bank()).toHaveLength(1);
  expect(store.has("shahi.connection")).toBe(false);
  await act(async () => { await value.switchComputer(computerId(a)); });
  expect(value.connected).toBe(true); ui.unmount();
});
test("a failed SSH switch retains both computers and permits returning to relay", async () => {
  const ssh: ComputerConnection = { kind: "ssh", ssh: { host: "test", port: 22, username: "test", remotePort: 7272, passcode: "stub", auth: { kind: "password", password: "stub" } } };
  (openTunnel as jest.Mock).mockRejectedValue(new Error("Box offline"));
  store.set(COMPUTERS_KEY, JSON.stringify([{ id: computerId(ssh), name: "SSH", connection: ssh, pins: [] }]));
  const ui = await mount(); act(() => value.signInRelay(a)); await act(async () => {});
  await act(async () => { await value.switchComputer(computerId(ssh)); });
  expect(value.computers).toHaveLength(2);
  await act(async () => { await value.switchComputer(computerId(a)); });
  expect(value.connected).toBe(true); ui.unmount();
});
test("a keychain failure keeps the current transport usable", async () => {
  const ui = await mount(); await pairBoth();
  const before = connection.relay;
  (SecureStore.setItemAsync as jest.Mock).mockRejectedValueOnce(new Error("Keychain unavailable"));
  await act(async () => { await expect(value.switchComputer(computerId(a))).rejects.toThrow("Keychain unavailable"); });
  expect(connection.relay).toBe(before);
  expect(value.connected).toBe(true); ui.unmount();
});

test("pairing another code directly preserves the old computer without carrying its pins", async () => {
  const ui = await mount();
  act(() => value.signInRelay(a)); await act(async () => {});
  act(() => value.togglePin("a-pin")); await act(async () => {});
  act(() => value.signInRelay(b)); await act(async () => {});
  expect(value.pins.size).toBe(0);
  expect(value.computers).toHaveLength(2);
  await act(async () => { await value.switchComputer(computerId(a)); });
  expect(value.pins.has("a-pin")).toBe(true);
  ui.unmount();
});

 test("switching preserves both sockets and background dashboards", async () => {
  const ui = await mount(); await pairBoth();
  const [socketA, socketB] = mockSockets;
  await act(async () => { await value.switchComputer(computerId(a)); });
  expect(socketA.close).not.toHaveBeenCalled();
  expect(socketB.close).not.toHaveBeenCalled();
  expect(mockSockets).toHaveLength(2);
  act(() => socketB.message({ type: "session", session: { ...snapshot, serverName: "Background B" } }));
  expect(value.session?.serverName).not.toBe("Background B");
  await act(async () => { await value.switchComputer(computerId(b)); });
  expect(value.session?.serverName).toBe("Background B");
  expect(mockSockets).toHaveLength(2);
  ui.unmount();
 });

test("restored internet reconnects every saved computer once without deleting pairing", async () => {
  const retry = jest.spyOn(RelayLink.prototype, "reconnect").mockImplementation(() => {});
  const previousState = AppState.currentState; AppState.currentState = "active";
  const ui = await mount(); await pairBoth();
  try {
    const listener = (addNetworkStateListener as jest.Mock).mock.calls.at(-1)![0];
    await act(async () => {
      listener({ type: "NONE", isConnected: false });
      listener({ type: "WIFI", isConnected: true, isInternetReachable: true });
      listener({ type: "WIFI", isConnected: true, isInternetReachable: true });
    });
    expect(retry).toHaveBeenCalledTimes(2);
    expect(bank()).toHaveLength(2);
  } finally { ui.unmount(); retry.mockRestore(); AppState.currentState = previousState; }
});

// iOS passes through "inactive" for Control Center, Notification Center, the
// app switcher and system alerts. Reconnecting on the way back dropped every
// healthy relay link and failed the sends in flight (pre-release review).
test("a glance at Control Center keeps every relay link; only a return from the background reconnects", async () => {
  const retry = jest.spyOn(RelayLink.prototype, "reconnect").mockImplementation(() => {});
  const ui = await mount(); await pairBoth();
  try {
    const change = (AppState.addEventListener as jest.Mock).mock.calls.at(-1)![1];
    act(() => { change("inactive"); change("active"); change("inactive"); change("active"); });
    expect(retry).not.toHaveBeenCalled();
    act(() => { change("inactive"); change("background"); change("active"); });
    expect(retry).toHaveBeenCalledTimes(2);
    expect(bank()).toHaveLength(2);
  } finally { ui.unmount(); retry.mockRestore(); }
});

// A new network is reported with reachability unknown, then known: two keys
// for one change, so every computer reconnected twice. And the first report
// at launch is not a change; every computer is already connecting.
test("joining a network reconnects every computer once, not again when its reachability is learned", async () => {
  const retry = jest.spyOn(RelayLink.prototype, "reconnect").mockImplementation(() => {});
  const previousState = AppState.currentState; AppState.currentState = "active";
  const wifi = { type: "WIFI", isConnected: true, isInternetReachable: true };
  (getNetworkStateAsync as jest.Mock).mockResolvedValueOnce(wifi);
  const ui = await mount(); await pairBoth();
  try {
    const listener = (addNetworkStateListener as jest.Mock).mock.calls.at(-1)![0];
    await act(async () => listener(wifi));
    expect(retry).not.toHaveBeenCalled();
    await act(async () => {
      listener({ type: "CELLULAR", isConnected: true, isInternetReachable: null });
      listener({ type: "CELLULAR", isConnected: true, isInternetReachable: true });
    });
    expect(retry).toHaveBeenCalledTimes(2);
  } finally { ui.unmount(); retry.mockRestore(); AppState.currentState = previousState; }
});

test("a delayed failure cannot turn a freshly restored dashboard offline", async () => {
  const ui = await mount(); await pairBoth();
  const socket = mockSockets.at(-1)!;
  await act(async () => socket.state("live"));
  let reject!: (e: Error) => void;
  (api.session as jest.Mock).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  let pending!: Promise<void>;
  act(() => { pending = value.refresh(); });
  await act(async () => {
    socket.message({ type: "session", session: snapshot });
    reject(new Error("old connection dropped")); await pending;
  });
  expect(value.link).toBe("live"); expect(value.error).toBeNull();
  ui.unmount();
});

// Found by the pre-release Maestro pass: a phone relaunched after its
// computer's API moved past the app's window showed a LIVE agent list, because
// the relay pushed a dashboard while /api/session was answering 426, and the
// frame both outdated the failure and cleared the error.
test("update needed is not painted over by a dashboard the relay pushes", async () => {
  const retry = jest.spyOn(RelayLink.prototype, "reconnect").mockImplementation(() => {});
  const ui = await mount(); await pairBoth();
  try {
    const socket = mockSockets.at(-1)!;
    await act(async () => socket.state("live"));
    let reject!: (e: Error) => void;
    (api.session as jest.Mock).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    let pending!: Promise<void>;
    act(() => { pending = value.refresh(); });
    await act(async () => {
      socket.message({ type: "session", session: snapshot });
      reject(new IncompatibleServerError("Update the Shahi app.", { min: 99, max: 99 })); await pending;
    });
    expect(value.error).toBeInstanceOf(IncompatibleServerError);
    expect(value.link).toBe("lost");
    expect(socket.close).toHaveBeenCalled();
    // Frames already in flight, and a stream the relay re-attaches, change nothing.
    await act(async () => { socket.state("live"); socket.message({ type: "session", session: snapshot }); });
    expect(value.error).toBeInstanceOf(IncompatibleServerError);
    expect(value.link).toBe("lost");
    // Once the computer is updated, Try again is the way out.
    await act(async () => { await value.reconnect(); });
    expect(value.error).toBeNull();
    expect(value.link).toBe("live");
  } finally { ui.unmount(); retry.mockRestore(); }
});

// An unmanaged computer has no build for the app to watch change: updated, it
// kept "Update needed" for as long as nobody tapped Try again (pre-release
// bug hunt).
test("update needed clears by itself once the computer speaks the app's contract", async () => {
  const retry = jest.spyOn(RelayLink.prototype, "reconnect").mockImplementation(() => {});
  const control = jest.fn(async () => null as unknown);
  (api as unknown as { control: typeof control }).control = control;
  const ui = await mount(); await pairBoth();
  try {
    const socket = mockSockets.at(-1)!;
    await act(async () => socket.state("live"));
    (api.session as jest.Mock).mockRejectedValue(new IncompatibleServerError("Update Shahi on this computer.", { min: 4, max: 4 }));
    await act(async () => { await value.refresh(); });
    expect(value.error).toBeInstanceOf(IncompatibleServerError);
    // Still the old one: asking again keeps the notice and the stream closed.
    socket.connect.mockClear();
    await act(async () => { await value.control!.refresh(); for (let i = 0; i < 10; i++) await Promise.resolve(); });
    expect(value.error).toBeInstanceOf(IncompatibleServerError);
    expect(socket.connect).not.toHaveBeenCalled();
    expect(socket.ensureConnected).not.toHaveBeenCalled();
    // Updated, to a build that now answers the handshake.
    (api.session as jest.Mock).mockResolvedValue(snapshot);
    control.mockResolvedValue({ control: 1, serverId: b.serverId, buildId: "new", api: { min: 5, max: 5 }, capabilities: [], backend: { state: "connected" }, update: { managed: true, phase: "idle", channel: "stable" } });
    await act(async () => { await value.control!.refresh(); for (let i = 0; i < 10; i++) await Promise.resolve(); });
    expect(value.error).toBeNull();
    expect(value.link).toBe("live");
    expect(socket.ensureConnected).toHaveBeenCalled();
  } finally { ui.unmount(); retry.mockRestore(); delete (api as unknown as { control?: unknown }).control; }
});

// herdr stopped: after a return from the background the session answered 503
// and the app said "Reconnecting…" while the computer's own report of herdr
// waited for its 30-second poll (pre-release bug hunt).
test("a session refused because herdr stopped asks the computer for herdr's state at once", async () => {
  const offline = { state: "offline", message: "herdr is offline. Shahi will reconnect automatically." };
  const handshake = (backend: object) => ({ control: 1, serverId: b.serverId, buildId: "one", api: { min: 5, max: 5 }, capabilities: [], backend, update: { managed: false, phase: "idle", channel: "stable" } });
  const control = jest.fn(async () => handshake({ state: "connected", version: "0.9.1", protocol: 22 }) as unknown);
  (api as unknown as { control: typeof control }).control = control;
  const ui = await mount(); await pairBoth();
  try {
    await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
    expect(value.control?.handshake?.backend.state).toBe("connected");
    const asked = control.mock.calls.length;
    control.mockResolvedValue(handshake(offline));
    (api.session as jest.Mock).mockRejectedValueOnce(new ApiError(offline.message, 503, "backend_unavailable"));
    await act(async () => { await value.refresh(); for (let i = 0; i < 10; i++) await Promise.resolve(); });
    expect(control.mock.calls.length).toBeGreaterThan(asked);
    expect(value.control?.handshake?.backend.state).toBe("offline");
  } finally { ui.unmount(); delete (api as unknown as { control?: unknown }).control; }
});

test("an offline notification wins over a late initial network snapshot and preserves drafts", async () => {
  const { nativeDraft } = require("./drafts");
  let finish!: (value: unknown) => void;
  (getNetworkStateAsync as jest.Mock).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const ui = await mount(); await pairBoth();
  const owner = value.api;
  const draft = nativeDraft(owner, "p1"); draft.text = "Continue this later";
  const listener = (addNetworkStateListener as jest.Mock).mock.calls.at(-1)![0];
  act(() => listener({ type: "NONE", isConnected: false, isInternetReachable: false }));
  expect(value.online).toBe(false);
  await act(async () => finish({ type: "WIFI", isConnected: true, isInternetReachable: true }));
  expect(value.online).toBe(false);
  expect(nativeDraft(value.api, "p1").text).toBe("Continue this later");
  await act(async () => listener({ type: "WIFI", isConnected: true, isInternetReachable: true }));
  expect(value.online).toBe(true);
  expect(value.api).toBe(owner);
  expect(nativeDraft(value.api, "p1").text).toBe("Continue this later");
  expect(value.computers).toHaveLength(2);
  ui.unmount();
});

// herdr reuses pane ids: close the highest space, restart herdr, create one,
// and its panes have the old ids. The pre-release bug hunt pinned w3:p1 and
// found the next conversation to get that id starred.
test("a pin on one conversation does not pin the next conversation to get its pane id", async () => {
  (api.session as jest.Mock).mockResolvedValue({ ...snapshot, panes: [{ paneId: "w3:p1", instanceId: "term_a", status: "idle" }] });
  const ui = await mount();
  act(() => value.signInRelay(a)); await act(async () => {});
  act(() => value.togglePin("w3:p1")); await act(async () => {});
  expect(value.pins.has("w3:p1")).toBe(true);
  act(() => mockSockets.at(-1).message({ type: "session", session: { ...snapshot, panes: [{ paneId: "w3:p1", instanceId: "term_b", status: "idle" }] } }));
  await act(async () => {});
  expect(value.pins.has("w3:p1")).toBe(false);
  expect(bank().find((c: { id: string }) => c.id === computerId(a)).pins).toEqual([]);
  ui.unmount();
});
