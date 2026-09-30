import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { Linking, Text } from "react-native";
import { ClientUpdateGate, useClientUpdateRequired } from "./client-update-gate";
import { IOS_APP_URL, type UpdateRule } from "@shahi/shared/client-update";

let mockChanged: (rule: UpdateRule | null) => void;
const mockCheck = jest.fn(async () => true);
jest.mock("@shahi/shared/client-update", () => ({
  ...jest.requireActual("@shahi/shared/client-update"),
  ClientUpdateCheck: jest.fn().mockImplementation((options: { changed: typeof mockChanged }) => {
    mockChanged = options.changed;
    return { restore: async () => {}, check: mockCheck };
  }),
}));
jest.mock("expo-constants", () => ({ __esModule: true, default: { nativeBuildVersion: "27" } }));
jest.mock("@/components/text", () => ({ Text: require("react-native").Text }));

beforeEach(() => { Object.defineProperty(globalThis, "__DEV__", { configurable: true, value: false }); });
afterEach(() => { Object.defineProperty(globalThis, "__DEV__", { configurable: true, value: true }); jest.restoreAllMocks(); });

test("an independent update requirement blocks navigation, links to Apple, and can be revoked without losing the mounted screen", async () => {
  const open = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
  const states: boolean[] = [];
  function Screen() { states.push(useClientUpdateRequired()); return <Text>Existing draft</Text>; }
  const view = render(<ClientUpdateGate><Screen /></ClientUpdateGate>);
  await waitFor(() => expect(mockCheck).toHaveBeenCalled());
  act(() => mockChanged({ minimumBuild: 28, expiresAt: "2026-09-30T00:00:00Z", message: "Fix Reader" }));
  expect(view.getByText("Update Shahi")).toBeTruthy();
  expect(states.at(-1)).toBe(true); // Dictation receives active=false and stops.
  fireEvent.press(view.getByText("Open App Store"));
  expect(open).toHaveBeenCalledWith(IOS_APP_URL);
  fireEvent.press(view.getByText("Open TestFlight"));
  expect(open).toHaveBeenCalledWith("itms-beta://");
  await act(async () => fireEvent.press(view.getByText("Check again")));
  expect(mockCheck).toHaveBeenCalledWith(true);
  act(() => mockChanged(null));
  expect(view.queryByText("Update Shahi")).toBeNull();
  expect(view.getByText("Existing draft")).toBeTruthy();
  expect(states.at(-1)).toBe(false);
});
