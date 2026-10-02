import { fireEvent, render } from "@testing-library/react-native";
import { ComputerSwitcher } from "./computer-switcher";

jest.mock("expo-router", () => ({ router: { push: jest.fn(), replace: jest.fn() }, useFocusEffect: jest.fn() }));
const mockState: { computers: { id: string; name: string; address: string; link: string; named?: boolean }[]; activeComputerId: string | null; session: { serverName?: string } | null } = {
  computers: [],
  activeComputerId: null,
  session: { serverName: "stub-box" },
};
jest.mock("@/lib/session", () => ({
  useSession: () => ({ ...mockState, switchComputer: jest.fn() }),
}));

beforeEach(() => {
  mockState.computers = [];
  mockState.activeComputerId = null;
  mockState.session = { serverName: "stub-box" };
});

// Build 32's header read "… relay.getshahi.dev · y… CONNECTING" while a
// fresh pairing waited for its first session: a computer's name was its relay
// address until then.
test("a computer that has not said its name yet is not called by its relay address", () => {
  mockState.computers = [{ id: "a", name: "Your computer", named: false, address: "relay.getshahi.dev · yxhmsPLw", link: "connecting" }];
  mockState.activeComputerId = "a";
  mockState.session = null;
  const view = render(<ComputerSwitcher />);
  expect(view.getByText("Your computer ▾")).toBeTruthy();
  expect(view.queryByText(/relay\.getshahi\.dev/)).toBeNull();
  mockState.session = { serverName: "Mac" };
  view.rerender(<ComputerSwitcher />);
  expect(view.getByText("Mac ▾")).toBeTruthy();
});

// At AX5 the name scaled inside a navigation bar that does not grow and read
// "stub-…" beside a LIVE that stays capped (September 2026 review). A bar item
// keeps the bar's size and offers the name full size on a long press.
test("the header's computer name stays readable at accessibility sizes", () => {
  const view = render(<ComputerSwitcher />);
  const trigger = view.getByTestId("computer-switcher");
  expect(trigger.props.accessibilityShowsLargeContentViewer).toBe(true);
  expect(trigger.props.accessibilityLargeContentTitle).toBe("stub-box");
  expect(trigger.props.accessibilityValue).toEqual({ text: "stub-box" });
  expect(view.getByText("stub-box ▾").props.maxFontSizeMultiplier).toBe(1.2);
});

// The current computer was marked only by a "✓" in its name, which VoiceOver
// read aloud as "check mark, stub-box" with no selected state (pre-release bug
// hunt).
test("the current computer is announced as selected, not by a spoken tick", () => {
  mockState.computers = [
    { id: "a", name: "stub-box", address: "relay.example", link: "live" },
    { id: "b", name: "laptop", address: "ssh://me@laptop", link: "lost" },
  ];
  mockState.activeComputerId = "a";
  const view = render(<ComputerSwitcher />);
  fireEvent.press(view.getByTestId("computer-switcher"));
  const current = view.getByTestId("quick-computer-a");
  expect(current.props.accessibilityState).toMatchObject({ selected: true });
  expect(current.props.accessibilityLabel).toBe("stub-box, relay.example, Connected");
  const other = view.getByTestId("quick-computer-b");
  expect(other.props.accessibilityState).toMatchObject({ selected: false });
  expect(other.props.accessibilityLabel).toBe("laptop, ssh://me@laptop, Offline · retrying");
});

// Device audit, build 28: which computer needs you is the reason to open this
// list, so each row says it beside its status, ahead of how it is reached.
test("each computer's waiting count shows beside its status", () => {
  mockState.computers = [
    { id: "a", name: "stub-box", address: "relay.example", link: "live" },
    { id: "b", name: "laptop", address: "relay.example · b", link: "live", waiting: 3 } as never,
  ];
  mockState.activeComputerId = "a";
  const view = render(<ComputerSwitcher />);
  fireEvent.press(view.getByTestId("computer-switcher"));
  expect(view.getByText("Connected · 3 waiting")).toBeTruthy();
});
