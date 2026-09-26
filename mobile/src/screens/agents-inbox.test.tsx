import { router } from "expo-router";
import { UnreachableError } from "@shahi/shared/errors";
import { fireEvent, render } from "@testing-library/react-native";
import { reviewKey, type DashboardPane, type Reviewed } from "@shahi/shared";
import { Agents } from "./agents";
const pane = (paneId: string, status: DashboardPane["status"]): DashboardPane => ({ paneId, status, workspaceId: "w", workspaceLabel: "project", tabId: paneId, agent: "codex", title: paneId, cwd: null, focused: false, hasPrompt: false, isAgent: true, prompt: null, preview: "Result", activity: null });
const mockState = {
  session: { panes: [pane("Waiting task", "blocked"), pane("Completed task", "done"), pane("Busy task", "working")] } as { panes: DashboardPane[] } | null,
  prompts: {}, reviewed: {} as Reviewed, link: "live", error: null as Error | null, server: "relay://computer", pins: new Set(),
  markReviewed: jest.fn((p: DashboardPane) => { mockState.reviewed = { ...mockState.reviewed, [p.paneId]: reviewKey(p) }; }),
  answeredPrompt: jest.fn(), refresh: jest.fn(async () => {}), answered: {}, togglePin: jest.fn(), reconnect: jest.fn(), signOut: jest.fn(),
};
jest.mock("@/lib/session", () => ({ useSession: () => mockState }));
jest.mock("@/lib/scroll-memory", () => ({ useRememberedScroll: () => ({}) }));
jest.mock("@/components/avatar", () => ({ Avatar: () => null }));
jest.mock("@/components/greeting-logo", () => ({ GreetingLogo: () => null }));
jest.mock("@/components/icons", () => ({ Icon: () => null, AgentIcon: () => null }));
jest.mock("expo-router", () => ({ router: { push: jest.fn() }, Stack: { Screen: () => null } }));
jest.mock("react-native-gesture-handler", () => ({ RectButton: require("react-native").Pressable }));
jest.mock("react-native-gesture-handler/ReanimatedSwipeable", () => ({ __esModule: true, default: ({ children }: any) => children }));
test("inbox keeps unanswered requests while completed work can be reviewed", () => {
  const open = jest.fn();
  const view = render(<Agents onOpenPane={open} />);
  fireEvent.press(view.getByLabelText("Inbox 2"));
  expect(view.getByText("What needs me?")).toBeTruthy();
  expect(view.queryByText("Busy task")).toBeNull();
  fireEvent.press(view.getByTestId("row-Completed task"));
  expect(open).toHaveBeenCalledWith("Completed task");
  fireEvent.press(view.getByLabelText("Mark Completed task reviewed"));
  view.rerender(<Agents onOpenPane={open} />);
  expect(view.queryByText("Completed task")).toBeNull();
  expect(view.getByLabelText("Inbox 1")).toBeTruthy();
  expect(view.getByText(/WAITING ON YOU/)).toBeTruthy();
});

test("Switch server on the offline screen opens computers without deleting the pairing", () => {
  const previous = mockState.session;
  mockState.session = null;
  mockState.error = new UnreachableError("box", "relay", "offline");
  try {
    const view = render(<Agents onOpenPane={jest.fn()} />);
    fireEvent.press(view.getByTestId("switch-server"));
    expect(router.push).toHaveBeenCalledWith("/computers");
    expect(mockState.signOut).not.toHaveBeenCalled();
  } finally { mockState.session = previous; mockState.error = null; }
});

test("provider chips use friendly names while filtering by the raw provider kind", () => {
  const previous = mockState.session;
  mockState.session = { panes: [{ ...pane("Antigravity task", "idle"), agent: "agy" }, pane("Codex task", "idle")] };
  try {
    const view = render(<Agents onOpenPane={jest.fn()} />);
    fireEvent.press(view.getByLabelText("Antigravity"));
    expect(view.getByTestId("row-Antigravity task")).toBeTruthy();
    expect(view.queryByTestId("row-Codex task")).toBeNull();
  } finally { mockState.session = previous; }
});

test("search finds conversation, space and folder while retaining the provider filter", () => {
  const previous = mockState.session;
  mockState.session = { panes: [
    { ...pane("Release plan", "idle"), workspaceLabel: "Launch", cwd: "/work/aurora" },
    { ...pane("Other work", "idle"), agent: "claude", workspaceLabel: "Launch" },
  ] };
  try {
    const view = render(<Agents onOpenPane={jest.fn()} />);
    fireEvent.press(view.getByLabelText("Codex"));
    for (const query of ["release", "LAUNCH", "aurora"]) {
      fireEvent.changeText(view.getByLabelText("Search agents"), query);
      expect(view.getByTestId("row-Release plan")).toBeTruthy();
      expect(view.queryByTestId("row-Other work")).toBeNull();
    }
    fireEvent.changeText(view.getByLabelText("Search agents"), "not found");
    expect(view.getByText(/No matching conversations/)).toBeTruthy();
    fireEvent.press(view.getByLabelText("Clear search"));
    expect(view.getByTestId("row-Release plan")).toBeTruthy();
    expect(view.queryByTestId("row-Other work")).toBeNull();
  } finally { mockState.session = previous; }
});

test("conversation rows reorder on new messages while pinned conversations stay first", () => {
  const previous = mockState.session;
  const previousPins = mockState.pins;
  try {
    mockState.pins = new Set(["Pinned"]);
    mockState.session = { panes: [
      { ...pane("Older", "working"), lastMessageAt: 10 },
      { ...pane("Newest", "idle"), lastMessageAt: 30 },
      { ...pane("Pinned", "idle"), lastMessageAt: 5 },
    ] };
    const view = render(<Agents onOpenPane={jest.fn()} />);
    const ids = () => view.getAllByTestId(/^row-/).map(row => row.props.testID);
    expect(ids()).toEqual(["row-Pinned-pinned", "row-Newest", "row-Older"]);
    mockState.session.panes = mockState.session.panes.map(p => p.title === "Older" ? { ...p, lastMessageAt: 40 } : p);
    view.rerender(<Agents onOpenPane={jest.fn()} />);
    expect(ids()).toEqual(["row-Pinned-pinned", "row-Older", "row-Newest"]);
  } finally { mockState.session = previous; mockState.pins = previousPins; }
});
