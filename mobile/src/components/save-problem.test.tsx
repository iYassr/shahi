import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { SaveProblem } from "./save-problem";

const mockRetry = jest.fn(async () => {});
let mockSaveError: Error | null = null;
jest.mock("@/lib/session", () => ({ useSession: () => ({ saveError: mockSaveError, retrySave: mockRetry }) }));
beforeEach(() => { mockRetry.mockClear(); mockSaveError = null; });

// An unsigned build 32 lost its pairing on relaunch after saying only
// NOT RESPONDING: the failure is the Keychain's, and what it risks is the
// next launch, so that is what the card says.
test("a pairing the Keychain would not keep is said to be at risk when the app closes, with a way to save it again", async () => {
  mockSaveError = new Error("Couldn't save your computers securely.");
  render(<SaveProblem />);
  expect(screen.getByText("Couldn't save your computers securely.")).toBeTruthy();
  expect(screen.getByText(/may not be here after you close Shahi/)).toBeTruthy();
  expect(screen.queryByText(/NOT RESPONDING|Reconnecting/)).toBeNull();
  await act(async () => { fireEvent.press(screen.getByText("Try again")); });
  expect(mockRetry).toHaveBeenCalledTimes(1);
});

test("nothing is shown while the computers are saved", () => {
  render(<SaveProblem />);
  expect(screen.queryByTestId("save-problem")).toBeNull();
});
