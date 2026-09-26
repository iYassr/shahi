import { fireEvent, render } from "@testing-library/react-native";
import { router } from "expo-router";
import PaneRoute from "../app/pane/[paneId]";

let mockPanes: { paneId: string; instanceId?: string; isAgent?: boolean }[] = [];
let mockPaneId = "w1:p9";
let mockInstance: string | undefined;
const mockMounts: string[] = [];
jest.mock("expo-router", () => ({
  router: { back: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({ paneId: mockPaneId, ...(mockInstance ? { instance: mockInstance } : {}) }),
}));
jest.mock("@/lib/session", () => ({ useSession: () => ({ session: { panes: mockPanes } }) }));
jest.mock("@/screens/pane", () => ({
  Pane: ({ paneId }: { paneId: string }) => {
    require("react").useEffect(() => { mockMounts.push(paneId); }, []);
    return null;
  },
}));
jest.mock("react-native-safe-area-context", () => ({ SafeAreaView: require("react-native").View }));

beforeEach(() => { jest.clearAllMocks(); mockPanes = []; mockPaneId = "w1:p9"; mockInstance = undefined; mockMounts.length = 0; });

test("keeps a newly created conversation open until its list entry arrives", () => {
  const view = render(<PaneRoute />);
  expect(router.back).not.toHaveBeenCalled();
  mockPanes = [{ paneId: "w1:p9" }];
  view.rerender(<PaneRoute />);
  expect(router.back).not.toHaveBeenCalled();
  mockPanes = [];
  view.rerender(<PaneRoute />);
  expect(router.back).toHaveBeenCalledTimes(1);
});

test("switching to a new conversation does not reuse the previous entry", () => {
  mockPanes = [{ paneId: "w1:p9" }];
  const view = render(<PaneRoute />);
  mockPaneId = "w1:p10";
  view.rerender(<PaneRoute />);
  expect(router.back).not.toHaveBeenCalled();
});

// herdr reuses pane ids: close the highest space, restart herdr, create one,
// and its panes have the old ids (pre-release bug hunt).
test("a notification for a conversation that has ended says so instead of opening the new one", () => {
  mockInstance = "term_a";
  mockPanes = [{ paneId: "w1:p9", instanceId: "term_b" }];
  const view = render(<PaneRoute />);
  expect(view.getByText(/has ended/)).toBeTruthy();
  expect(mockMounts).toEqual([]);
  fireEvent.press(view.getByText("Open what runs there now"));
  expect(view.queryByText(/has ended/)).toBeNull();
  expect(mockMounts).toEqual(["w1:p9"]);
});

test("while a notification for the conversation still there opens it", () => {
  mockInstance = "term_a";
  mockPanes = [{ paneId: "w1:p9", instanceId: "term_a" }];
  const view = render(<PaneRoute />);
  expect(view.queryByText(/has ended/)).toBeNull();
  expect(mockMounts).toEqual(["w1:p9"]);
});

test("an open pane starts over when another program takes its pane id, but not when its occupant is first learned", () => {
  const view = render(<PaneRoute />);
  mockPanes = [{ paneId: "w1:p9", instanceId: "term_a" }];
  view.rerender(<PaneRoute />);
  expect(mockMounts).toHaveLength(1);
  mockPanes = [{ paneId: "w1:p9", instanceId: "term_b" }];
  view.rerender(<PaneRoute />);
  expect(mockMounts).toHaveLength(2);
});

test("an open pane starts over when its agent quits and leaves the shell", () => {
  mockPanes = [{ paneId: "w1:p9", instanceId: "term_a", isAgent: true }];
  const view = render(<PaneRoute />);
  mockPanes = [{ paneId: "w1:p9", instanceId: "term_a", isAgent: false }];
  view.rerender(<PaneRoute />);
  expect(mockMounts).toHaveLength(2);
  view.rerender(<PaneRoute />);
  expect(mockMounts).toHaveLength(2);
});
