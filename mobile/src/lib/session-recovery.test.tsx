import { act, render, waitFor } from "@testing-library/react-native";
import { SessionProvider, useSession } from "./session";
import { api, connection } from "./api";
import { openTunnel, closeTunnel } from "./tunnel";
import type { SshProfile } from "./ssh";

const mockSockets: Array<{ watch: jest.Mock; close: jest.Mock; ensureConnected: jest.Mock }> = [];
jest.mock("./tunnel", () => ({ openTunnel: jest.fn(), closeTunnel: jest.fn(async () => {}) }));
jest.mock("./api", () => {
  const actual = jest.requireActual("./api");
  return { ...actual, api: { login: jest.fn(async () => {}), session: jest.fn() },
    SessionSocket: class {
      watch = jest.fn(); close = jest.fn(); ensureConnected = jest.fn(); connect = jest.fn();
      constructor() { mockSockets.push(this); }
    } };
});
let value: ReturnType<typeof useSession>;
function Probe() { value = useSession(); return null; }
const profile: SshProfile = { host: "fake-box", port: 22, username: "test", remotePort: 7272, passcode: "stub-only", auth: { kind: "password", password: "fake" } };
const snapshot = { panes: [], tabs: [], workspaces: [], version: "test", protocol: 20 };
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => { jest.clearAllMocks(); mockSockets.length = 0; (api.session as jest.Mock).mockResolvedValue(snapshot); });

test("concurrent recovery rebuilds one tunnel, authenticates its new port, and resumes the watched pane", async () => {
  const ui = render(<SessionProvider><Probe /></SessionProvider>);
  await waitFor(() => expect(value.ready).toBe(true));
  act(() => value.signInSsh(profile));
  await act(async () => {});
  act(() => value.watch("p1"));
  const opened = deferred<string>();
  (openTunnel as jest.Mock).mockReturnValue(opened.promise);
  let first!: Promise<void>; let second!: Promise<void>;
  act(() => { first = value.reconnect(); second = value.reconnect(); });
  expect(first).toBe(second);
  expect(openTunnel).toHaveBeenCalledTimes(1);
  await act(async () => { opened.resolve("http://127.0.0.1:54321"); await first; });
  expect(connection.baseUrl).toBe("http://127.0.0.1:54321");
  expect(api.login).toHaveBeenCalledWith("stub-only", expect.any(Function));
  expect(mockSockets[0]!.watch).toHaveBeenLastCalledWith("p1");
  expect(mockSockets[0]!.ensureConnected).toHaveBeenCalledTimes(1);
  ui.unmount();
});

test("sign-out cancels a pending recovery before it can authenticate or reopen the socket", async () => {
  const ui = render(<SessionProvider><Probe /></SessionProvider>);
  await waitFor(() => expect(value.ready).toBe(true));
  act(() => value.signInSsh(profile));
  await act(async () => {});
  const opened = deferred<string>();
  (openTunnel as jest.Mock).mockReturnValue(opened.promise);
  let work!: Promise<void>;
  act(() => { work = value.reconnect(); });
  act(() => value.signOut());
  await act(async () => { opened.resolve("http://127.0.0.1:54322"); await work; });
  expect(api.login).not.toHaveBeenCalled();
  expect(closeTunnel).toHaveBeenCalled();
  expect(value.connected).toBe(false);
  expect(mockSockets[0]!.ensureConnected).not.toHaveBeenCalled();
  ui.unmount();
});
