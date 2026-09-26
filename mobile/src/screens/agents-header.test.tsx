import { render } from "@testing-library/react-native";
import type { ReactElement } from "react";
import type { DashboardPane } from "@shahi/shared";
import { IncompatibleServerError } from "@/lib/errors";
import { Agents } from "./agents";

/*
 * The Agents header, the way expo-router keeps it: the options a screen last
 * set stay until another render sets new ones. The pre-release bug hunt found
 * a green LIVE above "Update needed", and LIVE over a computer whose herdr had
 * stopped.
 */
const waiting: DashboardPane = {
  paneId: "w1:p1", status: "blocked", workspaceId: "w1", workspaceLabel: "project", tabId: "t1", agent: "claude",
  title: "Fix the login redirect loop", cwd: "/work/project", focused: false, hasPrompt: true, isAgent: true,
  prompt: null, preview: null, activity: null,
};
const connected = { state: "connected", version: "0.9.1", protocol: 22 };
const mockState = {
  api: { answerPrompt: jest.fn() },
  session: { panes: [waiting] } as { panes: DashboardPane[] } | null,
  prompts: { "w1:p1": { question: "Allow this edit?", answer: "digit", options: [{ index: 1, label: "Yes", selected: true }, { index: 2, label: "No", selected: false }] } },
  answered: {}, reviewed: {}, link: "live", error: null as Error | null, server: "relay://computer", pins: new Set<string>(),
  computers: [{ id: "c1", name: "Studio" }], activeComputerId: "c1",
  control: { pending: false, error: null, handshake: { backend: connected as { state: string; message?: string }, update: { managed: false, phase: "idle" } }, refresh: jest.fn() },
  markReviewed: jest.fn(), answeredPrompt: jest.fn(), refresh: jest.fn(async () => {}), togglePin: jest.fn(), reconnect: jest.fn(),
};
let mockOptions: { headerRight?: () => ReactElement } = {};
jest.mock("@/lib/session", () => ({ useSession: () => mockState }));
jest.mock("@/lib/scroll-memory", () => ({ useRememberedScroll: () => ({}) }));
jest.mock("@/components/avatar", () => ({ Avatar: () => null }));
jest.mock("@/components/greeting-logo", () => ({ GreetingLogo: () => null }));
jest.mock("@/components/icons", () => ({ Icon: () => null, AgentIcon: () => null }));
jest.mock("@/components/computer-switcher", () => ({ ComputerSwitcher: () => null }));
jest.mock("expo-router", () => ({
  router: { push: jest.fn() },
  // Kept, like a navigator's setOptions: a render without a Stack.Screen
  // leaves the previous header in place.
  Stack: { Screen: ({ options }: { options: typeof mockOptions }) => { mockOptions = options; return null; } },
}));
jest.mock("react-native-gesture-handler", () => ({ RectButton: require("react-native").Pressable }));
jest.mock("react-native-gesture-handler/ReanimatedSwipeable", () => ({ __esModule: true, default: ({ children }: any) => children }));

const header = () => render(mockOptions.headerRight!());
beforeEach(() => {
  mockOptions = {};
  mockState.link = "live"; mockState.error = null; mockState.session = { panes: [waiting] };
  mockState.control.handshake.backend = connected;
});

test("the header never says LIVE above Update needed", () => {
  const view = render(<Agents onOpenPane={jest.fn()} />);
  expect(header().getByText("LIVE")).toBeTruthy();
  // The computer answers 426 on return to the foreground.
  mockState.link = "lost";
  mockState.error = new IncompatibleServerError("Update Shahi on this computer.", { min: 4, max: 4 });
  view.rerender(<Agents onOpenPane={jest.fn()} />);
  expect(view.getByText("Update needed")).toBeTruthy();
  const badge = header();
  expect(badge.queryByText("LIVE")).toBeNull();
  expect(badge.getByText("UPDATE NEEDED")).toBeTruthy();
});

test("with herdr stopped behind a live link, the header says so and waiting cards cannot be answered", () => {
  mockState.control.handshake.backend = { state: "offline", message: "herdr is offline. Shahi will reconnect automatically." };
  const view = render(<Agents onOpenPane={jest.fn()} />);
  expect(header().getByText("HERDR OFFLINE")).toBeTruthy();
  expect(view.getByText("herdr isn’t running on Studio")).toBeTruthy();
  expect(view.getByText(/can’t be answered yet/)).toBeTruthy();
  expect(view.getByLabelText("1. Yes").props.accessibilityState).toMatchObject({ disabled: true });
  // herdr back: the options work again.
  mockState.control.handshake.backend = connected;
  view.rerender(<Agents onOpenPane={jest.fn()} />);
  expect(header().getByText("LIVE")).toBeTruthy();
  expect(view.queryByText(/can’t be answered yet/)).toBeNull();
  expect(view.getByLabelText("1. Yes").props.accessibilityState).toMatchObject({ disabled: false });
});
