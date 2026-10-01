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
const mockSession = { workspaces: [{ workspaceId: "w1", label: "Project" }, { workspaceId: "w2", label: "Notes" }] as { workspaceId: string; label: string }[] };
jest.mock("@/lib/session", () => ({ useSession: () => ({
  ready: true, activeComputerId: "c1",
  session: mockSession,
  refresh: mockRefresh,
}) }));
jest.mock("@/screens/spaces", () => {
  const { Button } = require("react-native");
  return {
    PickSpace: ({ onPick, onNewSpace }: any) => <>
      {["w1", "w2"].map(workspaceId => <Button key={workspaceId} title={`Choose ${workspaceId}`} onPress={() => onPick({ workspaceId })} />)}
      <Button title="New space" onPress={onNewSpace} />
    </>,
    NewSpace: ({ onCreated, onCancel }: any) => <>
      <Button title="Create w3" onPress={() => onCreated("w3")} />
      <Button title="Close new space" onPress={onCancel} />
    </>,
    NewAgent: ({ space, onStarted }: any) => <Button title={`Finish in ${space.workspaceId}`} onPress={() => onStarted(`${space.workspaceId}:p2`)} />,
  };
});

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = {};
  mockSession.workspaces = [{ workspaceId: "w1", label: "Project" }, { workspaceId: "w2", label: "Notes" }];
});

// Device audit, build 28: "+ New agent" on the Agents tab offered only the
// spaces that already existed, so an agent in a new folder meant leaving to
// make the space and starting over.
test("a space made from Choose a space goes straight on to its agent form", () => {
  const view = render(<NewAgentRoute />);
  fireEvent.press(screen.getByText("New space"));
  fireEvent.press(screen.getByText("Create w3"));
  expect(mockRefresh).toHaveBeenCalledTimes(1);
  // Made on the computer, not yet in this session: not the space list again.
  expect(screen.getByText("Opening the new space…")).toBeTruthy();
  expect(screen.queryByText("Choose w1")).toBeNull();
  mockSession.workspaces = [...mockSession.workspaces, { workspaceId: "w3", label: "New" }];
  view.rerender(<NewAgentRoute />);
  fireEvent.press(screen.getByText("Finish in w3"));
  expect(router.replace).toHaveBeenCalledWith({ pathname: "/pane/[paneId]", params: { paneId: "w3:p2", computer: "c1" } });
});

test("closing a space being made returns to the list, not out of new agent", () => {
  render(<NewAgentRoute />);
  fireEvent.press(screen.getByText("New space"));
  fireEvent.press(screen.getByText("Close new space"));
  expect(screen.getByText("Choose w1")).toBeTruthy();
  expect(router.back).not.toHaveBeenCalled();
});

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
