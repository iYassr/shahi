import { fireEvent, render } from "@testing-library/react-native";
import { ComputerSwitcher } from "./computer-switcher";

jest.mock("expo-router", () => ({ router: { push: jest.fn(), replace: jest.fn() }, useFocusEffect: jest.fn() }));
const mockState: { computers: { id: string; name: string; address: string; link: string }[]; activeComputerId: string | null } = {
  computers: [],
  activeComputerId: null,
};
jest.mock("@/lib/session", () => ({
  useSession: () => ({ ...mockState, session: { serverName: "stub-box" }, switchComputer: jest.fn() }),
}));

beforeEach(() => {
  mockState.computers = [];
  mockState.activeComputerId = null;
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
