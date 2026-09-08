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
  clearPrompt: jest.fn(), togglePin: jest.fn(), reconnect: jest.fn(), signOut: jest.fn(),
};
jest.mock("@/lib/session", () => ({ useSession: () => mockState }));
jest.mock("@/lib/scroll-memory", () => ({ useRememberedScroll: () => ({}) }));
jest.mock("@/components/avatar", () => ({ Avatar: () => null }));
jest.mock("@/components/greeting-logo", () => ({ GreetingLogo: () => null }));
jest.mock("@/components/icons", () => ({ Icon: () => null }));
jest.mock("expo-router", () => ({ router: { push: jest.fn() }, Stack: { Screen: () => null } }));
jest.mock("react-native-gesture-handler", () => ({ RectButton: require("react-native").Pressable }));
jest.mock("react-native-gesture-handler/ReanimatedSwipeable", () => ({ __esModule: true, default: ({ children }: any) => children }));
test("inbox keeps unanswered requests while completed work can be reviewed", () => {
  const open = jest.fn();
  const view = render(<Agents onOpenPane={open} />);
  fireEvent.press(view.getByText("Inbox 2"));
  expect(view.getByText("What needs me?")).toBeTruthy();
  expect(view.queryByText("Busy task")).toBeNull();
  fireEvent.press(view.getByTestId("row-Completed task"));
  expect(open).toHaveBeenCalledWith("Completed task");
  fireEvent.press(view.getByLabelText("Mark Completed task reviewed"));
  view.rerender(<Agents onOpenPane={open} />);
  expect(view.queryByText("Completed task")).toBeNull();
  expect(view.getByText("Inbox 1")).toBeTruthy();
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
