import { fireEvent, render, screen } from "@testing-library/react-native";
import { router } from "expo-router";
import NewAgentRoute from "../app/new-agent";

const mockRefresh = jest.fn();
let mockParams: { workspaceId?: string } = {};
const mockNavigation = { setParams: jest.fn(), canGoBack: () => true, goBack: jest.fn() };
jest.mock("expo-router", () => ({
  router: { replace: jest.fn(), back: jest.fn(), push: jest.fn() },
  useLocalSearchParams: () => mockParams,
  useNavigation: () => mockNavigation,
}));
jest.mock("@/lib/session", () => ({ useSession: () => ({
  ready: true, activeComputerId: "c1",
  session: { workspaces: [{ workspaceId: "w1", label: "Project" }, { workspaceId: "w2", label: "Notes" }] },
  refresh: mockRefresh,
}) }));
jest.mock("@/screens/spaces", () => {
  const { Button } = require("react-native");
  return {
    PickSpace: ({ onPick }: any) => <>{["w1", "w2"].map(workspaceId => <Button key={workspaceId} title={`Choose ${workspaceId}`} onPress={() => onPick({ workspaceId })} />)}</>,
    NewAgent: ({ space, onStarted }: any) => <Button title={`Finish in ${space.workspaceId}`} onPress={() => onStarted(`${space.workspaceId}:p2`)} />,
  };
});

beforeEach(() => { jest.clearAllMocks(); mockParams = {}; });

test.each([[false, "w1"], [true, "w1"], [false, "w2"], [true, "w2"]] as const)("opens the created conversation directly (from space: %s, target: %s)", (fromSpace, workspaceId) => {
  if (fromSpace) mockParams = { workspaceId };
  render(<NewAgentRoute />);
  expect(router.replace).not.toHaveBeenCalled();
  if (!fromSpace) fireEvent.press(screen.getByText(`Choose ${workspaceId}`));
  fireEvent.press(screen.getByText(`Finish in ${workspaceId}`));
  expect(mockRefresh).toHaveBeenCalledTimes(1);
  expect(router.replace).toHaveBeenCalledTimes(1);
  expect(router.replace).toHaveBeenCalledWith({ pathname: "/pane/[paneId]", params: { paneId: `${workspaceId}:p2`, computer: "c1" } });
  expect(router.back).not.toHaveBeenCalled();
  expect(router.push).not.toHaveBeenCalled();
});
