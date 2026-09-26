import { Alert, Dimensions, StyleSheet } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { Settings } from "./settings";

const mockSignOut = jest.fn();
const mockLogout = jest.fn(async () => {});
jest.mock("@/lib/api", () => ({ api: { logout: () => mockLogout() } }));

const mockStackOptions = jest.fn();
jest.mock("expo-router", () => ({
  router: { replace: jest.fn(), push: jest.fn() },
  useIsFocused: () => true,
  Stack: { Screen: ({ options }: { options: unknown }) => { mockStackOptions(options); return null; } },
}));
jest.mock("expo-constants", () => ({ __esModule: true, default: { expoConfig: { version: "1.0.0" } } }));
jest.mock("@/lib/push", () => ({ enablePush: jest.fn(), pushEnabled: jest.fn(async () => false) }));
jest.mock("@/components/paired-devices", () => ({ PairedDevices: () => null }));
jest.mock("@/lib/session", () => ({
  useLastUpdate: () => Date.now(),
  useSession: () => ({
    api: require("@/lib/api").api, transport: require("@/lib/api").connection, computers: [],
    session: { serverName: "test-box", version: "0.8.2", protocol: 20 },
    link: "live",
    signOut: mockSignOut,
    pins: new Set(),
    clearPins: jest.fn(),
    terminalWidth: 100,
    setTerminalWidth: jest.fn(),
    server: "relay://relay.getshahi.dev",
  }),
}));
import { router } from "expo-router";

test("sign out warns before deleting the connection needed to return", async () => {
  jest.spyOn(Alert, "alert").mockImplementation(jest.fn());
  render(<Settings />);

  fireEvent.press(screen.getByText("Sign out"));
  expect(mockSignOut).not.toHaveBeenCalled();
  const [title, message, buttons] = (Alert.alert as jest.Mock).mock.calls[0]!;
  expect(title).toBe("Sign out of test-box?");
  expect(message).toMatch(/new pairing code/);
  await act(async () => { await buttons.find((button: { text: string }) => button.text === "Sign out").onPress(); });
  expect(mockLogout).toHaveBeenCalledTimes(1);
  expect(mockLogout.mock.invocationCallOrder[0]).toBeLessThan(mockSignOut.mock.invocationCallOrder[0]!);
  expect(mockSignOut).toHaveBeenCalledTimes(1);
  expect(router.replace).toHaveBeenCalledWith("/connect");
});

test("keeps the last row above the floating tab bar", () => {
  const { UNSAFE_getByType } = render(<Settings />);
  const scroll = UNSAFE_getByType(require("react-native").ScrollView);
  expect(scroll.props.contentContainerStyle.paddingBottom).toBeGreaterThanOrEqual(96);
});

test("connection details stay hidden until requested without hiding device management", () => {
  const view = render(<Settings />);
  expect(view.getByText("test-box")).toBeTruthy();
  expect(view.getByText("Devices with access")).toBeTruthy();
  expect(view.queryByText(/relay:\/\//)).toBeNull();
  fireEvent.press(view.getByTestId("server-identity"));
  expect(view.getByText(/Encrypted relay connection/)).toBeTruthy();
  expect(view.getByText(/relay:\/\/relay.getshahi.dev/)).toBeTruthy();
  fireEvent.press(view.getByTestId("server-identity"));
  expect(view.queryByText(/relay:\/\//)).toBeNull();
});

// On the iOS 27 simulator "Settings" was a blank band until scrolled: UIKit
// hosts this screen's large title in the scroll view, beneath the bar, and the
// tab stack's opaque scroll-edge background covered it (September 2026 review).
test("the Settings large title is not covered by an opaque bar at rest", () => {
  mockStackOptions.mockClear();
  render(<Settings />);
  expect(mockStackOptions).toHaveBeenCalledWith(expect.objectContaining({ headerLargeStyle: { backgroundColor: "transparent" } }));
});

test("the open-source licenses are one tap from Settings", () => {
  const view = render(<Settings />);
  fireEvent.press(view.getByText("Open-source licenses"));
  expect(router.push).toHaveBeenCalledWith("/licenses");
});

// AX5 on the simulator drew "Computers" one letter per line beside its
// "Switch or add" value (September 2026 review).
describe("at accessibility text sizes", () => {
  const window = Dimensions.get("window");
  const screenSize = Dimensions.get("screen");
  afterEach(() => act(() => Dimensions.set({ window, screen: screenSize })));
  const hostParent = (node: { parent: any }) => {
    let parent = node.parent;
    while (parent && typeof parent.type !== "string") parent = parent.parent;
    return parent;
  };

  function expectValueUnderLabel(view: ReturnType<typeof render>) {
    const label = view.getByText("Computers");
    expect(StyleSheet.flatten(label.props.style).flex ?? 0).toBe(0);
    expect(StyleSheet.flatten(hostParent(label).props.style).flexDirection).toBe("column");
    expect(hostParent(view.getByText("Switch or add"))).toBe(hostParent(label));
  }

  test("a Settings row puts its value under its label at a cold launch", () => {
    act(() => Dimensions.set({ window: { ...window, fontScale: 3.12 }, screen: screenSize }));
    expectValueUnderLabel(render(<Settings />));
  });

  // Jest's React Native preset starts at a font scale of 2, already over the
  // large-text threshold, so this starts at the default size explicitly:
  // started at 2 it never crossed it, and passed for a row that read the size
  // once at mount.
  test("a Settings row puts its value under its label when the size changes while running", () => {
    act(() => Dimensions.set({ window: { ...window, fontScale: 1 }, screen: screenSize }));
    const view = render(<Settings />);
    expect(StyleSheet.flatten(hostParent(view.getByText("Computers")).props.style).flexDirection).toBe("row");
    act(() => Dimensions.set({ window: { ...window, fontScale: 3.12 }, screen: screenSize }));
    expectValueUnderLabel(view);
  });
});
