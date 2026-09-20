import { render } from "@testing-library/react-native";
import { router } from "expo-router";
import PaneRoute from "../app/pane/[paneId]";

let mockPanes: { paneId: string }[] = [];
let mockPaneId = "w1:p9";
jest.mock("expo-router", () => ({
  router: { back: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({ paneId: mockPaneId }),
}));
jest.mock("@/lib/session", () => ({ useSession: () => ({ session: { panes: mockPanes } }) }));
jest.mock("@/screens/pane", () => ({ Pane: () => null }));
jest.mock("react-native-safe-area-context", () => ({ SafeAreaView: require("react-native").View }));

beforeEach(() => { jest.clearAllMocks(); mockPanes = []; mockPaneId = "w1:p9"; });

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
