import { fireEvent, render, waitFor } from "@testing-library/react-native";
import type { DashboardPane, ParsedPrompt } from "@shahi/shared";
import { Agents } from "./agents";

/**
 * Every Claude Code permission offers "1. Yes", so the server can only tell a
 * stale card from the request now on screen if the card says which question it
 * showed (pre-release review). This is the list's half: the tap sends the
 * card's own question and context along with the option.
 */
const bash: ParsedPrompt = {
  question: "Do you want to proceed?",
  answer: "digit",
  options: [
    { index: 1, label: "Yes", selected: true },
    { index: 2, label: "No", selected: false },
  ],
  context: ["Bash command", "rm -rf build dist\nDelete build and dist directories"],
};
const pane: DashboardPane = {
  paneId: "w1:p1", status: "blocked", workspaceId: "w", workspaceLabel: "project", tabId: "w1:t1", agent: "claude",
  title: "Clean up", cwd: null, focused: false, hasPrompt: true, isAgent: true, prompt: bash, preview: null, activity: null,
};
const mockState = {
  session: { panes: [pane] },
  prompts: { "w1:p1": bash } as Record<string, ParsedPrompt>,
  reviewed: {}, link: "live", error: null, server: "relay://computer", pins: new Set(),
  api: { answerPrompt: jest.fn(async () => ({ ok: true })) },
  markReviewed: jest.fn(), clearPrompt: jest.fn(), togglePin: jest.fn(), reconnect: jest.fn(), signOut: jest.fn(),
};
jest.mock("@/lib/session", () => ({ useSession: () => mockState }));
jest.mock("@/lib/scroll-memory", () => ({ useRememberedScroll: () => ({}) }));
jest.mock("@/components/avatar", () => ({ Avatar: () => null }));
jest.mock("@/components/greeting-logo", () => ({ GreetingLogo: () => null }));
jest.mock("@/components/icons", () => ({ Icon: () => null, AgentIcon: () => null }));
jest.mock("expo-router", () => ({ router: { push: jest.fn() }, Stack: { Screen: () => null } }));
jest.mock("react-native-gesture-handler", () => ({ RectButton: require("react-native").Pressable }));
jest.mock("react-native-gesture-handler/ReanimatedSwipeable", () => ({ __esModule: true, default: ({ children }: any) => children }));

test("answering from the list says which question the card showed", async () => {
  const view = render(<Agents onOpenPane={jest.fn()} />);
  fireEvent.press(view.getByText("Yes"));
  await waitFor(() => expect(mockState.api.answerPrompt).toHaveBeenCalledTimes(1));
  expect(mockState.api.answerPrompt).toHaveBeenCalledWith("w1:p1", bash.options[0], bash);
});
