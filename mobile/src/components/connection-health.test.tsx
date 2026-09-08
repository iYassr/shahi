import { router } from "expo-router";
jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
import { act, fireEvent, render } from "@testing-library/react-native";
import { UnreachableError } from "@shahi/shared/errors";
import { ConnectionHealth } from "./connection-health";
const mockReconnect = jest.fn();
const mockState = { link: "lost", error: null as Error | null, server: "ssh://computer", reconnect: mockReconnect };
jest.mock("@/lib/session", () => ({ useSession: () => mockState }));
beforeEach(() => { mockState.link = "lost"; mockState.error = null; mockReconnect.mockReset(); });
test("retry waits for reconnection and disappears when live", async () => {
  let finish!: () => void;
  mockReconnect.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const view = render(<ConnectionHealth />);
  expect(view.getByText(/reopen the tunnel/)).toBeTruthy();
  fireEvent.press(view.getByText("Retry connection"));
  fireEvent.press(view.getByText("Retrying…"));
  expect(mockReconnect).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  mockState.link = "live";
  view.rerender(<ConnectionHealth />);
  expect(view.queryByText("Retry connection")).toBeNull();
});
test("a relay-confirmed disconnected box tells the user to check the computer", () => {
  mockState.error = new UnreachableError("box", "relay", "offline");
  const view = render(<ConnectionHealth />);
  expect(view.getByText("Computer disconnected")).toBeTruthy();
  expect(view.getByText(/Wake the computer/)).toBeTruthy();
});

test("switching from the disconnect banner opens saved computers", () => {
  mockState.error = new UnreachableError("box", "relay", "offline");
  const view = render(<ConnectionHealth />);
  fireEvent.press(view.getByText("Switch computer"));
  expect(router.push).toHaveBeenCalledWith("/computers");
});
