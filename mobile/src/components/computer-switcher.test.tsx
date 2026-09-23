import { render } from "@testing-library/react-native";
import { ComputerSwitcher } from "./computer-switcher";

jest.mock("expo-router", () => ({ router: { push: jest.fn(), replace: jest.fn() } }));
jest.mock("@/lib/session", () => ({
  useSession: () => ({ computers: [], activeComputerId: null, session: { serverName: "stub-box" }, switchComputer: jest.fn() }),
}));

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
