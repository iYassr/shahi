/**
 * A notification tapped while the app was killed opens its pane, for an SSH
 * computer as well as a relay one.
 *
 * The root layout matches the tap's `serverId` against the saved computers.
 * A relay computer's id is in its pairing code, but an SSH computer's was
 * only learned once its tunnel and login were up — after the tap had already
 * been routed, so the person landed on the chooser instead of the question
 * waiting for them (pre-release review). The real layout, SessionProvider
 * and ComputerSession run here; the tunnel never opens, as on a cold launch
 * where SSH takes its time, and only the router and the notification source
 * are faked.
 */
import { act, render } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import type { SshProfile } from "@/lib/ssh";

let mockTap: ((paneId: string, serverId?: string, instanceId?: string) => void) | null = null;
jest.mock("@/lib/push", () => ({
  onNotificationTapped: (open: (paneId: string, serverId?: string, instanceId?: string) => void) => { mockTap = open; return () => { mockTap = null; }; },
}));
jest.mock("@/lib/navigate", () => ({ openPane: jest.fn() }));
jest.mock("expo-router", () => ({
  router: { push: jest.fn(), replace: jest.fn() },
  ThemeProvider: ({ children }: { children: unknown }) => children,
  DarkTheme: { colors: {} },
}));
jest.mock("expo-router/stack", () => {
  const Stack = Object.assign(() => null, { Screen: () => null });
  return { Stack };
});
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock("react-native-gesture-handler", () => ({ GestureHandlerRootView: ({ children }: { children: unknown }) => children }));
jest.mock("expo", () => ({
  ...jest.requireActual("expo"),
  requireOptionalNativeModule: (name: string) => (name === "SshTunnel"
    ? { hostKey: jest.fn(), open: jest.fn(() => new Promise(() => {})), close: jest.fn(async () => {}) }
    : null),
}));

import { router } from "expo-router";
import { openPane } from "@/lib/navigate";
import { COMPUTERS_KEY, computerId, type SavedComputer } from "@/lib/computers";
import RootLayout from "../app/_layout";

const profile: SshProfile = { host: "box.example", port: 22, username: "me", remotePort: 7171, passcode: "2468", auth: { kind: "password", password: "fake" } };
const relay: SavedComputer["connection"] = { kind: "relay", relay: "https://relay.example", serverId: "relay-box-id", deviceId: "d1", deviceSecret: "c2VjcmV0" };

function keychain(computers: SavedComputer[]) {
  const store = new Map<string, string>([
    [COMPUTERS_KEY, JSON.stringify(computers)],
    ["shahi.knownhost.box.example_22", "cGlubmVkLWhvc3Qta2V5"],
  ]);
  (SecureStore.getItemAsync as jest.Mock).mockImplementation(async (key: string) => store.get(key) ?? null);
  (SecureStore.setItemAsync as jest.Mock).mockImplementation(async (key: string, data: string) => { store.set(key, data); });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(globalThis, "requestAnimationFrame").mockImplementation((fn: FrameRequestCallback) => { fn(0); return 0; });
});

test("a notification tapped on a cold launch opens its pane on a saved SSH computer whose tunnel is not up yet", async () => {
  const ssh: SavedComputer = { id: computerId({ kind: "ssh", ssh: profile }), name: "Box", connection: { kind: "ssh", ssh: profile }, pins: [], serverId: "ssh-box-id" };
  // Two computers, so the one-computer fallback cannot pick it by elimination.
  keychain([ssh, { id: computerId(relay), name: "Other", connection: relay, pins: [] }]);
  const ui = render(<RootLayout />);
  await act(async () => { for (let i = 0; i < 20 && !mockTap; i++) await Promise.resolve(); });
  expect(mockTap).not.toBeNull();

  await act(async () => { mockTap!("w1:p1", "ssh-box-id"); for (let i = 0; i < 20; i++) await Promise.resolve(); });

  expect(router.push).not.toHaveBeenCalledWith("/computers");
  expect(openPane).toHaveBeenCalledWith("w1:p1");
  ui.unmount();
});

// herdr reuses pane ids; the pane route compares the occupant a notification
// was about with the one there now (pre-release bug hunt).
test("a notification tap opens its pane with the conversation it was about", async () => {
  keychain([{ id: computerId(relay), name: "Relay", connection: relay, pins: [] }]);
  const ui = render(<RootLayout />);
  await act(async () => { for (let i = 0; i < 20 && !mockTap; i++) await Promise.resolve(); });
  await act(async () => { mockTap!("w3:p1", "relay-box-id", "term_a"); for (let i = 0; i < 20; i++) await Promise.resolve(); });
  expect(openPane).toHaveBeenCalledWith("w3:p1", "term_a");
  ui.unmount();
});
