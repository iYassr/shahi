import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { modesFor, type Space, type Session } from "@shahi/shared";
import { NewAgent, SpaceDetail, Spaces } from "./spaces";
import { router } from "expo-router";
import { BackHandler } from "react-native";

const mockStackOptions = jest.fn();
const mockApi = { agents: jest.fn(), startAgent: jest.fn() };
const mockSpace = { workspaceId: "w1", label: "Project", cwdPath: "/tmp/project", status: "idle" } as Space;
const mockSession = { serverName: "My computer", workspaces: [mockSpace], panes: [], tabs: [] } as unknown as Session;
jest.mock("@/lib/session", () => ({ useSession: () => ({ api: mockApi, session: mockSession, computers: [], link: "live", server: "relay:https://secret-relay.example" }) }));
jest.mock("@/components/avatar", () => ({ Avatar: () => null }));
jest.mock("@/components/connection-health", () => ({ ConnectionHealth: () => null }));
jest.mock("@/lib/scroll-memory", () => ({ useRememberedScroll: () => ({}) }));
jest.mock("react-native-safe-area-context", () => ({ SafeAreaView: require("react-native").View }));
jest.mock("expo-router", () => ({ useFocusEffect: jest.fn(), router: { back: jest.fn(), push: jest.fn(), replace: jest.fn() }, Stack: { Screen: ({ options }: any) => { mockStackOptions(options); return options.headerRight?.() ?? null; } } }));

const kinds = "pi claude codex gemini cursor devin agy cline omp mastracode opencode copilot kimi kiro droid amp grok hermes kilo qodercli qwen letta maki muse".split(" ");
const choices = kinds.flatMap<[string, string | null]>(kind => {
  const modes = modesFor(kind);
  return modes.length ? modes.map(mode => [kind, mode.id] as const) : [[kind, null] as const];
});
beforeEach(() => {
  jest.clearAllMocks();
  mockApi.agents.mockResolvedValue({ agents: kinds.map(kind => ({ kind })) });
  mockApi.startAgent.mockResolvedValue({ paneId: "w1:p-new", tabId: "w1:t-new" });
});

async function ready() { await screen.findByTestId("agent-kind-claude"); }

test.each(choices)("starts %s with exactly the selected permission %s", async (kind, mode) => {
  const onStarted = jest.fn();
  render(<NewAgent space={mockSpace} onStarted={onStarted} />);
  await ready();
  fireEvent.press(screen.getByTestId(`agent-kind-${kind}`));
  if (mode) fireEvent.press(screen.getByTestId(`agent-mode-${mode}`));
  fireEvent.press(screen.getByTestId("start-agent"));
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith("w1:p-new"));
  expect(mockApi.startAgent).toHaveBeenCalledTimes(1);
  // The space's name goes too: herdr hands a closed space's id to the next one
  // after a restart, and the computer refuses a start whose name no longer
  // matches rather than put it in the wrong space (pre-release bug hunt, B43).
  expect(mockApi.startAgent).toHaveBeenCalledWith({ clientRequestId: expect.any(String), workspaceId: "w1", workspaceLabel: "Project", cwd: "/tmp/project", label: null, kind, name: expect.stringMatching(new RegExp(`^${kind}-[a-zA-Z0-9]+$`)), mode });
});

test("switching agent resets an unsafe mode before submission", async () => {
  render(<NewAgent space={mockSpace} onStarted={jest.fn()} />);
  await ready();
  fireEvent.press(screen.getByTestId("agent-kind-claude"));
  fireEvent.press(screen.getByTestId("agent-mode-bypass"));
  fireEvent.press(screen.getByTestId("agent-kind-codex"));
  fireEvent.press(screen.getByTestId("start-agent"));
  await waitFor(() => expect(mockApi.startAgent).toHaveBeenCalledWith(expect.objectContaining({ kind: "codex", mode: modesFor("codex")[0]!.id })));
});

test("double taps start once and cannot close or change permissions during the operation", async () => {
  let resolve!: (value: unknown) => void;
  mockApi.startAgent.mockReturnValue(new Promise(r => { resolve = r; }));
  const onStarted = jest.fn();
  render(<NewAgent space={mockSpace} onStarted={onStarted} />);
  await ready();
  fireEvent.press(screen.getByTestId("agent-kind-codex"));
  const start = screen.getByTestId("start-agent");
  act(() => { fireEvent.press(start); fireEvent.press(start); });
  fireEvent.press(screen.getByText("Close"));
  expect(router.back).not.toHaveBeenCalled();
  expect(screen.getByTestId("agent-mode-bypass").props.accessibilityState.disabled).toBe(true);
  expect(mockApi.startAgent).toHaveBeenCalledTimes(1);
  await act(async () => resolve({ paneId: "w1:p-new" }));
  expect(onStarted).toHaveBeenCalledTimes(1);
});

test("an uncertain retry reuses the operation ID, while changing the choice starts a new operation", async () => {
  mockApi.startAgent.mockRejectedValue(new Error("Connection interrupted"));
  render(<NewAgent space={mockSpace} onStarted={jest.fn()} />);
  await ready();
  fireEvent.press(screen.getByTestId("start-agent"));
  await screen.findByText("Connection interrupted");
  fireEvent.press(screen.getByTestId("start-agent"));
  await screen.findByText("Connection interrupted");
  const first = mockApi.startAgent.mock.calls[0][0];
  expect(mockApi.startAgent.mock.calls[1][0].clientRequestId).toBe(first.clientRequestId);
  fireEvent.press(screen.getByTestId("agent-kind-codex"));
  fireEvent.press(screen.getByTestId("start-agent"));
  await screen.findByText("Connection interrupted");
  expect(mockApi.startAgent.mock.calls[2][0].clientRequestId).not.toBe(first.clientRequestId);
});

test("list failures can retry and cannot submit an absent agent", async () => {
  mockApi.agents.mockRejectedValueOnce(new Error("Unavailable"));
  render(<NewAgent space={mockSpace} onStarted={jest.fn()} />);
  await screen.findByText("Unavailable");
  fireEvent.press(screen.getByTestId("start-agent"));
  expect(mockApi.startAgent).not.toHaveBeenCalled();
  fireEvent.press(screen.getByTestId("retry-agent-list"));
  await ready();
  expect(screen.queryByText("Unavailable")).toBeNull();
});

test("an empty installed-agent list explains why creation is unavailable", async () => {
  mockApi.agents.mockResolvedValue({ agents: [] });
  render(<NewAgent space={mockSpace} onStarted={jest.fn()} />);
  await screen.findByText("No agents are installed on this computer yet.");
  fireEvent.press(screen.getByTestId("start-agent"));
  expect(mockApi.startAgent).not.toHaveBeenCalled();
});

test("Spaces shows the computer name and status without its relay address", () => {
  render(<Spaces session={mockSession} />);
  expect(screen.getByText("My computer ▾")).toBeTruthy();
  expect(screen.getByText("LIVE")).toBeTruthy();
  expect(screen.queryByText(/secret-relay/)).toBeNull();
});

test("a space starts creation for that exact workspace", () => {
  render(<SpaceDetail space={mockSpace} session={mockSession} />);
  fireEvent.press(screen.getByTestId("space-new-agent"));
  expect(router.push).toHaveBeenCalledWith({ pathname: "/new-agent", params: { workspaceId: "w1" } });
});


test("blocks system back and swipe during startup, then restores them after failure", async () => {
  let reject!: (reason: Error) => void;
  mockApi.startAgent.mockReturnValue(new Promise((_, r) => { reject = r; }));
  const remove = jest.fn();
  const listen = jest.spyOn(BackHandler, "addEventListener").mockReturnValue({ remove });
  render(<NewAgent space={mockSpace} onStarted={jest.fn()} />);
  await ready();
  expect(mockStackOptions).toHaveBeenLastCalledWith({ gestureEnabled: true });
  fireEvent.press(screen.getByTestId("start-agent"));
  expect(mockStackOptions).toHaveBeenLastCalledWith({ gestureEnabled: false });
  expect(listen).toHaveBeenCalledWith("hardwareBackPress", expect.any(Function));
  expect(listen.mock.calls.at(-1)![1](undefined as never)).toBe(true);
  await act(async () => reject(new Error("Failed")));
  expect(remove).toHaveBeenCalledTimes(1);
  expect(mockStackOptions).toHaveBeenLastCalledWith({ gestureEnabled: true });
  listen.mockRestore();
});

test.each(["success", "failure"])("forced unmount ignores late startup %s", async (outcome) => {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: Error) => void;
  mockApi.startAgent.mockReturnValue(new Promise((r, j) => { resolve = r; reject = j; }));
  const onStarted = jest.fn();
  const view = render(<NewAgent space={mockSpace} onStarted={onStarted} />);
  await ready();
  fireEvent.press(screen.getByTestId("start-agent"));
  view.unmount();
  await act(async () => {
    if (outcome === "success") resolve({ paneId: "old-computer:p1" });
    else reject(new Error("Old computer disconnected"));
  });
  expect(onStarted).not.toHaveBeenCalled();
  expect(router.replace).not.toHaveBeenCalled();
});
