import { act, render } from "@testing-library/react-native";
import { router } from "expo-router";
import ConnectRoute from "../app/connect";
import { redirectSystemPath } from "../app/+native-intent";
import { dismissPairing } from "@/lib/incoming-pairing";
const mockState = { ready: true, connected: false, addingComputer: false, computers: [{ id: "saved" }], signInSsh: jest.fn(), signInRelay: jest.fn() };
jest.mock("@/lib/session", () => ({ useSession: () => mockState }));
jest.mock("@/screens/connect", () => ({ Connect: () => null }));
jest.mock("expo-router", () => ({ router: { replace: jest.fn(), push: jest.fn(), canDismiss: () => false, dismissAll: jest.fn() } }));
const link = `shahi://pair#v=1&server=${"B".repeat(42)}A&relay=${encodeURIComponent("https://relay.example")}&secret=${"c".repeat(43)}`;
beforeEach(() => { jest.clearAllMocks(); mockState.addingComputer = false; mockState.connected = false; dismissPairing(); });
test("lost access opens saved computers instead of onboarding", () => {
  render(<ConnectRoute />);
  expect(router.replace).toHaveBeenCalledWith("/computers");
});
test("explicit Add a computer keeps the pairing form available", () => {
  mockState.addingComputer = true;
  render(<ConnectRoute />);
  expect(router.replace).not.toHaveBeenCalled();
});
// The iPhone Camera, or a tapped shahi://pair link, while another computer is
// saved — or open. Only Connect read links, and these redirects took it away
// before the confirm card could show: the link did nothing and said nothing.
test.each([["saved", false], ["open", true]])("a pairing link stays on Connect for its confirmation with a computer %s", (_, connected) => {
  mockState.connected = connected;
  expect(redirectSystemPath({ path: link, initial: false })).toBe("/connect");
  render(<ConnectRoute />);
  expect(router.replace).not.toHaveBeenCalled();
  act(() => dismissPairing());
  expect(router.replace).toHaveBeenCalledWith(connected ? "/" : "/computers");
});
test("other links route as before while the app runs", () => {
  expect(redirectSystemPath({ path: "shahi://pane/w1%3Ap1", initial: false })).toBe("shahi://pane/w1%3Ap1");
  expect(redirectSystemPath({ path: "shahi://pair#v=1&server=x", initial: false })).toBe("shahi://pair#v=1&server=x");
});
// A cold launch builds a stack of one: a hand-made link to a space, a sheet or
// a pane had nothing beneath it, and Back or Close led nowhere (pre-release
// bug hunt).
test("a cold launch from a link to a pane, a space or a sheet starts at the list, where Back leads somewhere", () => {
  for (const path of ["shahi://pane/does-not-exist", "shahi://pane/w1%3Ap1", "shahi://space/nope", "shahi://new-agent", "shahi://new-space", "shahi://computers", "/licenses"]) {
    expect(redirectSystemPath({ path, initial: true })).toBe("/");
  }
  for (const path of ["shahi://", "shahi://agents", "shahi://spaces/", "shahi://settings", "shahi://connect"]) {
    expect(redirectSystemPath({ path, initial: true })).toBe(path);
  }
  // A malformed pairing link still reaches the screen that sends it to Connect.
  expect(redirectSystemPath({ path: "shahi://pair#v=1&server=x", initial: true })).toBe("shahi://pair#v=1&server=x");
});
