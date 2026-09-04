import { Alert } from "react-native";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { Settings } from "./settings";

const mockSignOut = jest.fn();

jest.mock("expo-router", () => ({ router: { replace: jest.fn() } }));
jest.mock("expo-constants", () => ({ __esModule: true, default: { expoConfig: { version: "1.0.0" } } }));
jest.mock("@/lib/push", () => ({ enablePush: jest.fn() }));
jest.mock("@/components/paired-devices", () => ({ PairedDevices: () => null }));
jest.mock("@/lib/session", () => ({
  useLastUpdate: () => Date.now(),
  useSession: () => ({
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

test("sign out warns before deleting the connection needed to return", () => {
  jest.spyOn(Alert, "alert").mockImplementation(jest.fn());
  render(<Settings />);

  fireEvent.press(screen.getByText("Sign out"));
  expect(mockSignOut).not.toHaveBeenCalled();
  const [title, message, buttons] = (Alert.alert as jest.Mock).mock.calls[0]!;
  expect(title).toBe("Sign out of Shahi?");
  expect(message).toMatch(/new pairing code or your SSH details/);
  buttons.find((button: { text: string }) => button.text === "Sign out").onPress();
  expect(mockSignOut).toHaveBeenCalledTimes(1);
  expect(router.replace).toHaveBeenCalledWith("/connect");
});

test("keeps the last row above the floating tab bar", () => {
  const { UNSAFE_getByType } = render(<Settings />);
  const scroll = UNSAFE_getByType(require("react-native").ScrollView);
  expect(scroll.props.contentContainerStyle.paddingBottom).toBeGreaterThanOrEqual(96);
});
