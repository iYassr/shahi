import { fireEvent, render } from "@testing-library/react-native";
import { Alert } from "react-native";
import { Computers } from "./computers";

// The chooser a revoked phone lands on said only its fixed note, and nothing
// about the computer that had just disappeared (pre-release bug hunt).
const mockState = {
  computers: [{ id: "a", name: "Studio", address: "relay.example · abc", kind: "relay", link: "live" }],
  activeComputerId: null, connected: false, accessEnded: null as string | null,
  switchComputer: jest.fn(), addComputer: jest.fn(), revokeComputer: jest.fn(async () => {}), renameComputer: jest.fn(),
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

// Device audit, build 28: "Rename" and a red "Revoke this phone’s access" sat
// as loose links under every card, one tap below the card you meant to open.
describe("a computer's card", () => {
  test("opens the computer; renaming and revoking wait behind its menu", () => {
    const view = render(<Computers />);
    expect(view.queryByText("Revoke this phone’s access")).toBeNull();
    expect(view.queryByText("Rename")).toBeNull();
    fireEvent.press(view.getByLabelText("More for Studio"));
    expect(view.getByText("Rename")).toBeTruthy();
    expect(view.getByText("Revoke this phone’s access")).toBeTruthy();
    fireEvent.press(view.getByText("Cancel"));
    expect(view.queryByText("Revoke this phone’s access")).toBeNull();
  });

  test("revoking asks first, naming the computer, and only then ends access", () => {
    jest.spyOn(Alert, "alert").mockImplementation(jest.fn());
    const view = render(<Computers />);
    fireEvent.press(view.getByLabelText("More for Studio"));
    fireEvent.press(view.getByTestId("revoke-computer-a"));
    expect(mockState.revokeComputer).not.toHaveBeenCalled();
    const [title, , buttons] = (Alert.alert as jest.Mock).mock.calls[0]!;
    expect(title).toBe("Revoke this phone’s access to Studio?");
    buttons.find((b: { text: string }) => b.text === "Revoke access").onPress();
    expect(mockState.revokeComputer).toHaveBeenCalledWith("a");
  });

  test("its status and waiting count are prominent, its address a quiet second line", () => {
    mockState.computers = [{ id: "a", name: "Studio", address: "relay.example · abc", kind: "relay", link: "live", waiting: 2 } as never];
    const view = render(<Computers />);
    expect(view.getByText("Connected · 2 waiting")).toBeTruthy();
    expect(view.getByText("relay.example · abc")).toBeTruthy();
    expect(view.getByText("Open agents")).toBeTruthy();
  });
});
