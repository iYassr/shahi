import { act, render, waitFor } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { SessionProvider, useSession } from "./session";
import { api, connection, UnauthorizedError } from "./api";
import { COMPUTERS_KEY, computerId, type ComputerConnection } from "./computers";
import { openTunnel } from "./tunnel";
import { AppState } from "react-native";
import { addNetworkStateListener } from "expo-network";
import { RelayLink } from "./relay";

const mockSockets: any[] = [];
jest.mock("./tunnel", () => ({ openTunnel: jest.fn(), closeTunnel: jest.fn(async () => {}) }));
jest.mock("./push-registration", () => ({ configurePushProfile: jest.fn(), forgetPushRegistration: jest.fn(), restorePushRegistration: jest.fn(async () => {}) }));
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
const snapshot = { panes: [], tabs: [], workspaces: [], version: "test", protocol: 22 };
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
