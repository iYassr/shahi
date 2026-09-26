/**
 * The Notifications row in Settings says what the computer will do, and can
 * undo it.
 *
 * Pre-release bug hunt: the row's state lived only in the screen, so every
 * relaunch read "Off" while the computer kept notifying the phone; while it
 * read "On" it was disabled, and nothing called `unregisterPush`, so iOS
 * Settings or signing out were the only ways to stop the notifications. A relay
 * computer kept no record of its token at all.
 *
 * The screen, `lib/push` and `lib/push-registration` are real. The keychain's
 * storage, the notification module, the device and the computer's API are
 * faked; a "relaunch" is the screen mounting again after the session points
 * registration at the saved computer, which is what a cold launch does.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import type { ComputerConnection } from "@/lib/computers";

jest.mock("expo-router", () => ({
  router: { replace: jest.fn(), push: jest.fn() },
  useIsFocused: () => true,
  Stack: { Screen: () => null },
}));
jest.mock("expo-device", () => ({ isDevice: true }));
jest.mock("expo-constants", () => ({
  __esModule: true,
  default: { executionEnvironment: "standalone", expoConfig: { version: "1.0.0", extra: { eas: { projectId: "proj-1" } } } },
  ExecutionEnvironment: { Bare: "bare", Standalone: "standalone", StoreClient: "storeClient" },
}));
jest.mock("expo-notifications", () => ({
  setNotificationHandler: jest.fn(),
  getPermissionsAsync: jest.fn(async () => ({ granted: true })),
  requestPermissionsAsync: jest.fn(async () => ({ granted: true })),
  getExpoPushTokenAsync: jest.fn(async () => ({ data: "ExponentPushToken[phone]" })),
}));
jest.mock("@/components/paired-devices", () => ({ PairedDevices: () => null }));
jest.mock("@/components/connection-health", () => ({ ConnectionHealth: () => null }));
jest.mock("@/components/computer-update", () => ({ ComputerUpdate: () => null }));
const mockApi = {
  registerPush: jest.fn(async (_token: string) => ({ ok: true })),
  unregisterPush: jest.fn(async (_token: string) => ({ ok: true })),
  logout: jest.fn(async () => ({ ok: true })),
};
jest.mock("@/lib/session", () => ({
  useLastUpdate: () => Date.now(),
  useSession: () => ({
    api: mockApi, computers: [],
    session: { serverName: "test-box", version: "0.9.1", protocol: 22 },
    link: "live", signOut: jest.fn(), pins: new Set(), clearPins: jest.fn(),
    terminalWidth: 100, setTerminalWidth: jest.fn(), server: "relay://relay.getshahi.dev",
  }),
}));

import * as Notifications from "expo-notifications";
import { configurePushComputer } from "@/lib/push-registration";
import { Settings } from "./settings";

const relay: ComputerConnection = { kind: "relay", relay: "https://relay.getshahi.dev", serverId: "box-id", deviceId: "d1", deviceSecret: "c2VjcmV0" };
const keychain = new Map<string, string>();

beforeEach(() => {
  jest.clearAllMocks();
  keychain.clear();
  (SecureStore.getItemAsync as jest.Mock).mockImplementation(async (key: string) => keychain.get(key) ?? null);
  (SecureStore.setItemAsync as jest.Mock).mockImplementation(async (key: string, value: string) => { keychain.set(key, value); });
  (SecureStore.deleteItemAsync as jest.Mock).mockImplementation(async (key: string) => { keychain.delete(key); });
  (Notifications.getPermissionsAsync as jest.Mock).mockImplementation(async () => ({ granted: true }));
});

/** A cold launch: the session selects the saved computer, then the tabs mount. */
function launch() {
  configurePushComputer(null);
  configurePushComputer(relay);
  return render(<Settings />);
}

const row = () => screen.getByText("Notifications");
async function turnOn() {
  fireEvent.press(row());
  await waitFor(() => expect(screen.getByText("On")).toBeTruthy());
}

test("notifications turned on for a relay computer still read On after a relaunch", async () => {
  let ui = launch();
  expect(screen.getByText("Off")).toBeTruthy();
  await turnOn();
  expect(mockApi.registerPush).toHaveBeenCalledWith("ExponentPushToken[phone]");
  ui.unmount();

  ui = launch();
  expect(await screen.findByText("On")).toBeTruthy();
  expect(screen.getByText("Tap to stop notifications from this computer.")).toBeTruthy();
  ui.unmount();
});

test("notifications can be turned off from Settings, and stay off after a relaunch", async () => {
  let ui = launch();
  await turnOn();

  await act(async () => { fireEvent.press(row()); });
  await waitFor(() => expect(screen.getByText("Off")).toBeTruthy());
  expect(mockApi.unregisterPush).toHaveBeenCalledWith("ExponentPushToken[phone]");
  ui.unmount();

  ui = launch();
  await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
  expect(screen.getByText("Off")).toBeTruthy();
  ui.unmount();
});

test("a turn-off the computer never heard about still reads On, and says why", async () => {
  const ui = launch();
  await turnOn();
  mockApi.unregisterPush.mockRejectedValueOnce(new Error("The computer could not be reached."));

  await act(async () => { fireEvent.press(row()); });
  await waitFor(() => expect(screen.getByText(/^Still on\./)).toBeTruthy());
  expect(screen.getByText("On")).toBeTruthy();
  ui.unmount();
});

// Permission withdrawn in iOS Settings: nothing this phone receives is shown.
test("a saved registration with the permission withdrawn reads Off", async () => {
  let ui = launch();
  await turnOn();
  ui.unmount();

  (Notifications.getPermissionsAsync as jest.Mock).mockImplementation(async () => ({ granted: false }));
  ui = launch();
  await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
  expect(screen.getByText("Off")).toBeTruthy();
  ui.unmount();
});
