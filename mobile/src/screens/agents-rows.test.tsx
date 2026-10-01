import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { reviewKey, type DashboardPane, type Reviewed } from "@shahi/shared";
import { Agents } from "./agents";

/**
 * What a conversation row says, and what it offers, from the build 28 audit on
 * a real iPhone: rows had no time, a new agent's row showed its whole working
 * folder, finished work could only be reviewed one row at a time, and the
 * long-press offered nothing but Pin and Open screen.
 */
const NOW = new Date(2026, 9, 1, 14, 30).getTime();
const pane = (paneId: string, over: Partial<DashboardPane> = {}): DashboardPane => ({
  paneId, status: "idle", workspaceId: "w", workspaceLabel: "project", tabId: paneId, agent: "claude", title: paneId,
  cwd: "/Users/me/shahi-device-test/claude-new", focused: false, hasPrompt: false, isAgent: true, prompt: null, preview: null, activity: null, ...over,
});
const mockSessionLog = jest.fn();
const mockState = {
  session: { panes: [] as DashboardPane[] },
  api: { sessionLog: (...args: unknown[]) => mockSessionLog(...args) },
  prompts: {}, reviewed: {} as Reviewed, link: "live", error: null as Error | null, server: "relay://computer", pins: new Set(),
  markReviewed: jest.fn((p: DashboardPane) => { mockState.reviewed = { ...mockState.reviewed, [p.paneId]: reviewKey(p) }; }),
  answeredPrompt: jest.fn(), refresh: jest.fn(async () => {}), answered: {}, togglePin: jest.fn(), reconnect: jest.fn(), signOut: jest.fn(),
};
const mockClipboard = jest.fn(async (_text: string) => true);
jest.mock("expo-clipboard", () => ({ setStringAsync: (text: string) => mockClipboard(text) }));
jest.mock("@/lib/session", () => ({ useSession: () => mockState }));
jest.mock("@/lib/scroll-memory", () => ({ useRememberedScroll: () => ({}) }));
jest.mock("@/components/avatar", () => ({ Avatar: () => null }));
jest.mock("@/components/greeting-logo", () => ({ GreetingLogo: () => null }));
jest.mock("@/components/icons", () => ({ Icon: () => null, AgentIcon: () => null }));
jest.mock("expo-router", () => ({ router: { push: jest.fn() }, Stack: { Screen: () => null } }));
jest.mock("react-native-gesture-handler", () => ({ RectButton: require("react-native").Pressable }));
jest.mock("react-native-gesture-handler/ReanimatedSwipeable", () => ({ __esModule: true, default: ({ children }: any) => children }));

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
  mockState.reviewed = {};
  mockState.markReviewed.mockClear();
  mockSessionLog.mockReset();
  mockClipboard.mockClear();
});
afterEach(() => jest.useRealTimers());

test("a row says how long ago it moved, and a new agent says it has no messages instead of its folder", () => {
  mockState.session = { panes: [
    pane("Recent reply", { preview: "Fixed it.", lastMessageAt: NOW - 5 * 60_000 }),
    pane("Old reply", { preview: "Done.", lastMessageAt: new Date(2026, 8, 20, 9, 0).getTime() }),
    pane("Just started", { startedAt: NOW - 30_000 }),
    pane("Older computer"),
  ] };
  const view = render(<Agents onOpenPane={jest.fn()} />);
  expect(view.getByTestId("time-Recent reply")).toHaveTextContent("5m");
  expect(view.getByTestId("time-Old reply")).toHaveTextContent("Sep 20");
  // Before its first message, the time it started.
  expect(view.getByTestId("time-Just started")).toHaveTextContent("now");
  // An older computer sends neither, and no time is invented.
  expect(view.queryByTestId("time-Older computer")).toBeNull();
  expect(view.getAllByText("No messages yet")).toHaveLength(2);
  expect(view.queryByText(/shahi-device-test/)).toBeNull();
  // Read aloud with the row, in words.
  expect(view.getByTestId("row-Recent reply").props.accessibilityLabel).toContain("last active 5m ago");
});

test("a row's age keeps up while the list sits unchanged on screen", () => {
  mockState.session = { panes: [pane("Recent reply", { preview: "Fixed it.", lastMessageAt: NOW - 5 * 60_000 })] };
  const view = render(<Agents onOpenPane={jest.fn()} />);
  act(() => { jest.advanceTimersByTime(60_000); });
  expect(view.getByTestId("time-Recent reply")).toHaveTextContent("6m");
});

test("Mark all reviewed clears every finished conversation from the inbox at once", () => {
  mockState.session = { panes: [
    pane("First done", { status: "done", preview: "One" }),
    pane("Second done", { status: "done", preview: "Two" }),
    pane("Third done", { status: "done", preview: "Three" }),
  ] };
  const view = render(<Agents onOpenPane={jest.fn()} />);
  fireEvent.press(view.getByLabelText("Inbox 3"));
  fireEvent.press(view.getByText("Mark all reviewed"));
  expect(mockState.markReviewed).toHaveBeenCalledTimes(3);
  view.rerender(<Agents onOpenPane={jest.fn()} />);
  expect(view.getByText(/You’re caught up/)).toBeTruthy();
});

test("a single finished conversation is reviewed from its own row, without a Mark all", () => {
  mockState.session = { panes: [pane("Only done", { status: "done", preview: "One" })] };
  const view = render(<Agents onOpenPane={jest.fn()} />);
  fireEvent.press(view.getByLabelText("Inbox 1"));
  expect(view.queryByText("Mark all reviewed")).toBeNull();
  expect(view.getByLabelText("Mark Only done reviewed")).toBeTruthy();
});

test("a long press can mark finished work reviewed", () => {
  mockState.session = { panes: [pane("Done task", { status: "done", preview: "Result" })] };
  const view = render(<Agents onOpenPane={jest.fn()} />);
  fireEvent(view.getByTestId("row-Done task"), "longPress");
  fireEvent.press(view.getByText("Mark reviewed"));
  expect(mockState.markReviewed).toHaveBeenCalledWith(expect.objectContaining({ paneId: "Done task" }));
});

test("a long press copies the whole last reply, not the shortened preview", async () => {
  const whole = "## Summary\n\nThe parser now keeps its place. " + "Details follow. ".repeat(20);
  mockSessionLog.mockResolvedValue({ sessionId: "s", path: "p", total: 2, offset: 0, messages: [
    { id: "a", role: "agent", at: 1, blocks: [{ kind: "text", text: whole }] },
    { id: "b", role: "you", at: 2, blocks: [{ kind: "text", text: "Thanks" }] },
  ] });
  mockState.session = { panes: [pane("Talkative", { preview: "You: Thanks" })] };
  const view = render(<Agents onOpenPane={jest.fn()} />);
  fireEvent(view.getByTestId("row-Talkative"), "longPress");
  fireEvent.press(view.getByText("Copy last reply"));
  await waitFor(() => expect(mockClipboard).toHaveBeenCalledWith(whole.trim()));
  expect(mockSessionLog).toHaveBeenCalledWith("Talkative", 12);
});

test("an agent with nothing said offers nothing to copy", () => {
  mockState.session = { panes: [pane("Quiet")] };
  const view = render(<Agents onOpenPane={jest.fn()} />);
  fireEvent(view.getByTestId("row-Quiet"), "longPress");
  expect(view.queryByText("Copy last reply")).toBeNull();
  expect(view.queryByText("Mark reviewed")).toBeNull();
  expect(view.getByText("Open screen")).toBeTruthy();
});
