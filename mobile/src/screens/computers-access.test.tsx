import { render } from "@testing-library/react-native";
import { Computers } from "./computers";

// The chooser a revoked phone lands on said only its fixed note, and nothing
// about the computer that had just disappeared (pre-release bug hunt).
const mockState = {
  computers: [{ id: "a", name: "Studio", address: "relay.example · abc", kind: "relay", link: "live" }],
  activeComputerId: null, connected: false, accessEnded: null as string | null,
  switchComputer: jest.fn(), addComputer: jest.fn(), revokeComputer: jest.fn(),
};
jest.mock("@/lib/session", () => ({ useSession: () => mockState }));
jest.mock("@/lib/navigate", () => ({ resetTo: jest.fn(), showComputerHome: jest.fn() }));

test("the chooser a revoked phone lands on says which computer ended its access", () => {
  mockState.accessEnded = "This phone is no longer paired with Laptop. Show a new pairing code on that computer to connect again.";
  const view = render(<Computers />);
  const notice = view.getByTestId("access-ended");
  expect(notice.props.accessibilityRole).toBe("alert");
  expect(notice.props.children).toContain("no longer paired with Laptop");
  mockState.accessEnded = null;
  view.rerender(<Computers />);
  expect(view.queryByTestId("access-ended")).toBeNull();
});
