import { router } from "expo-router";
jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
import { act, fireEvent, render } from "@testing-library/react-native";
import { UnreachableError } from "@shahi/shared/errors";
import { ConnectionHealth, markResumed } from "./connection-health";
const mockReconnect = jest.fn();
const mockState = { link: "lost", error: null as Error | null, online: true, activeComputerId: "a", computers: [{ id: "a", name: "My Mac" }], server: "ssh://computer", reconnect: mockReconnect };
jest.mock("@/lib/session", () => ({ useSession: () => mockState }));
beforeEach(() => { mockState.link = "lost"; mockState.error = null; mockState.online = true; mockState.activeComputerId = "a"; mockReconnect.mockReset(); });
test("retry waits for reconnection and disappears when live", async () => {
  let finish!: () => void;
  mockReconnect.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const view = render(<ConnectionHealth />);
  expect(view.getByText(/reconnect securely/)).toBeTruthy();
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
  expect(view.getByText(/Wake your computer/)).toBeTruthy();
});

test("switching from the disconnect banner opens saved computers", () => {
  mockState.error = new UnreachableError("box", "relay", "offline");
  const view = render(<ConnectionHealth />);
  fireEvent.press(view.getByText("Switch computer"));
  expect(router.push).toHaveBeenCalledWith("/computers");
});

test("network loss explains phone connectivity and prevents futile manual retries", () => {
  mockState.online = false;
  const view = render(<ConnectionHealth />);
  expect(view.getByText("You’re offline")).toBeTruthy();
  expect(view.queryByText("Your draft stays here. Nothing is sent automatically.")).toBeNull();
  fireEvent.press(view.getByText("Retry connection"));
  expect(mockReconnect).not.toHaveBeenCalled();
});

test("switching computers does not keep another computer's retry error", async () => {
  mockReconnect.mockRejectedValue(new UnreachableError("box", "relay", "offline"));
  const view = render(<ConnectionHealth />);
  expect(view.getByText("Reconnecting to My Mac…")).toBeTruthy();
  fireEvent.press(view.getByText("Retry connection")); await act(async () => {});
  expect(view.getByText("Computer disconnected")).toBeTruthy();
  mockState.activeComputerId = "b"; view.rerender(<ConnectionHealth />);
  expect(view.queryByText("Computer disconnected")).toBeNull();
  expect(view.getByText("Reconnecting to your computer…")).toBeTruthy();
});

// Build 28 on a phone (October 2026): back in the foreground, the full
// "Computer disconnected" card, with buttons into the other computers, stood
// for about ten seconds over a computer that was fine and came back unaided.
describe("a reconnect that usually recovers by itself", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.useRealTimers(); markResumed(0); });

  test("a live link that drops shows one quiet line, and the full card only after the grace", () => {
    mockState.link = "live";
    const view = render(<ConnectionHealth />);
    mockState.link = "lost"; mockState.error = new UnreachableError("box", "relay", "offline");
    view.rerender(<ConnectionHealth />);
    expect(view.getByText("Reconnecting to My Mac…")).toBeTruthy();
    expect(view.queryByText("Computer disconnected")).toBeNull();
    expect(view.queryByText("Switch computer")).toBeNull();
    act(() => { jest.advanceTimersByTime(7_000); });
    expect(view.getByText("Computer disconnected")).toBeTruthy();
    expect(view.getByText("Retry connection")).toBeTruthy();
  });

  test("a drop that recovers within the grace never shows the card", () => {
    mockState.link = "live";
    const view = render(<ConnectionHealth />);
    mockState.link = "lost"; mockState.error = new UnreachableError("box", "relay", "offline");
    view.rerender(<ConnectionHealth />);
    act(() => { jest.advanceTimersByTime(3_000); });
    mockState.link = "live"; mockState.error = null;
    view.rerender(<ConnectionHealth />);
    act(() => { jest.advanceTimersByTime(10_000); });
    expect(view.queryByText("Computer disconnected")).toBeNull();
    expect(view.queryByTestId("connection-brief")).toBeNull();
  });

  test("a screen opened just after the app comes back waits too, though it never saw the link live", () => {
    markResumed(Date.now());
    mockState.error = new UnreachableError("box", "relay", "offline");
    const view = render(<ConnectionHealth />);
    expect(view.getByTestId("connection-brief")).toBeTruthy();
    act(() => { jest.advanceTimersByTime(7_000); });
    expect(view.getByText("Computer disconnected")).toBeTruthy();
  });

  test("being offline, which the person can fix, is never held back", () => {
    mockState.link = "live";
    const view = render(<ConnectionHealth />);
    mockState.link = "lost"; mockState.online = false;
    view.rerender(<ConnectionHealth />);
    expect(view.getByText("You’re offline")).toBeTruthy();
  });
});
