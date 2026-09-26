import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { AccessibilityInfo, Dimensions, StyleSheet } from "react-native";
import type { DashboardPane, ParsedPrompt } from "@shahi/shared";
import { Agents } from "./agents";

/*
 * The waiting card and the conversation rows, as a person using them sees and
 * hears them. Each test is named after what the September 2026 review found.
 */
const waiting: DashboardPane = {
  paneId: "w1:p1", status: "blocked", workspaceId: "w1", workspaceLabel: "project", tabId: "t1", agent: "claude",
  title: "Fix the login redirect loop", cwd: "/work/project", focused: false, hasPrompt: true, isAgent: true,
  prompt: null, preview: null, activity: null,
};
const working: DashboardPane = {
  ...waiting, paneId: "w1:p2", status: "working", title: "Convert PDF exports", hasPrompt: false,
  activity: { verb: "Reading", elapsed: "12s" } as DashboardPane["activity"], preview: "Converting page 3",
};
const question = (text: string, labels: string[]): ParsedPrompt => ({
  question: text, answer: "digit", context: [],
  options: labels.map((label, i) => ({ index: i + 1, label, selected: i === 0 })),
});

const mockState = {
  api: { answerPrompt: jest.fn() },
  session: { panes: [waiting, working] } as { panes: DashboardPane[] } | null,
  prompts: { "w1:p1": question("Allow this edit?", ["Yes", "No"]) } as Record<string, ParsedPrompt>,
  reviewed: {}, link: "live", error: null, server: "relay://computer", pins: new Set<string>(),
  markReviewed: jest.fn(), clearPrompt: jest.fn(), togglePin: jest.fn(), reconnect: jest.fn(),
};
jest.mock("@/lib/session", () => ({ useSession: () => mockState }));
jest.mock("@/lib/scroll-memory", () => ({ useRememberedScroll: () => ({}) }));
jest.mock("@/components/avatar", () => ({ Avatar: () => null }));
jest.mock("@/components/greeting-logo", () => ({ GreetingLogo: () => null }));
jest.mock("@/components/icons", () => ({ Icon: () => null, AgentIcon: () => null }));
jest.mock("expo-router", () => ({ router: { push: jest.fn() }, Stack: { Screen: () => null } }));
jest.mock("react-native-gesture-handler", () => ({ RectButton: require("react-native").Pressable }));
jest.mock("react-native-gesture-handler/ReanimatedSwipeable", () => ({ __esModule: true, default: ({ children }: any) => children }));

beforeEach(() => {
  mockState.api.answerPrompt.mockReset();
  mockState.clearPrompt.mockReset();
  mockState.prompts = { "w1:p1": question("Allow this edit?", ["Yes", "No"]) };
  jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockImplementation(() => {});
});

test("a refused answer on the Agents list says why and offers every option again", async () => {
  mockState.api.answerPrompt.mockRejectedValueOnce(new Error("the question in w1:p1 changed before the answer arrived"));
  const view = render(<Agents onOpenPane={jest.fn()} />);

  fireEvent.press(view.getByLabelText("2. No"));
  await waitFor(() => view.getByText(/Couldn’t answer: the question in w1:p1 changed/));
  expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(expect.stringMatching(/Couldn’t answer/));
  expect(mockState.clearPrompt).not.toHaveBeenCalled();
  expect(view.getByLabelText("1. Yes").props.accessibilityState).toMatchObject({ disabled: false });

  mockState.api.answerPrompt.mockResolvedValueOnce({ ok: true });
  fireEvent.press(view.getByLabelText("1. Yes"));
  await waitFor(() => expect(mockState.clearPrompt).toHaveBeenCalledWith("w1:p1"));
  expect(mockState.api.answerPrompt).toHaveBeenCalledTimes(2);
  expect(view.queryByText(/Couldn’t answer/)).toBeNull();
});

// Both places a waiting card appears: the main list and the Inbox's header.
test.each(["All", "Inbox 1"])("a new question on a still-waiting agent can be answered while the first answer is unanswered (%s)", (chip) => {
  mockState.api.answerPrompt.mockReturnValue(new Promise(() => {}));
  const view = render(<Agents onOpenPane={jest.fn()} />);
  fireEvent.press(view.getByLabelText(chip));
  fireEvent.press(view.getByLabelText("1. Yes"));
  expect(view.getByLabelText("2. No").props.accessibilityState).toMatchObject({ disabled: true });

  const next = question("Run the tests too?", ["Yes", "No"]);
  mockState.prompts = { "w1:p1": next };
  view.rerender(<Agents onOpenPane={jest.fn()} />);
  fireEvent.press(view.getByLabelText("2. No"));
  expect(mockState.api.answerPrompt).toHaveBeenCalledTimes(2);
  // Sent with the question the card now shows, so the server can refuse it
  // if the screen has moved on again.
  // The last argument is the pane's occupant, which this session's server does not name.
  expect(mockState.api.answerPrompt).toHaveBeenLastCalledWith("w1:p1", expect.objectContaining({ label: "No" }), next, undefined);
});

test("answer options are read by their words, with the terminal's cursor said as a state", () => {
  mockState.prompts = { "w1:p1": { question: "Trust this folder?", answer: "cursor", context: [], options: [
    { index: 1, label: "No, exit", selected: true },
    { index: 2, label: "Yes, I trust this folder", selected: false, detail: "Claude Code may read files here" },
  ] } };
  const view = render(<Agents onOpenPane={jest.fn()} />);
  // A cursor menu has no digits to read; the glyph and blank are never read.
  const no = view.getByLabelText("No, exit");
  const yes = view.getByLabelText("Yes, I trust this folder, Claude Code may read files here");
  expect(no.props.accessibilityState).toMatchObject({ selected: true });
  expect(yes.props.accessibilityState).toMatchObject({ selected: false });
  expect(view.queryByLabelText(/❯/)).toBeNull();
});

test("a conversation row says each fact once, title first", () => {
  const view = render(<Agents onOpenPane={jest.fn()} />);
  const label = view.getByTestId("row-w1:p2").props.accessibilityLabel as string;
  expect(label).toBe("Convert PDF exports, Claude, working, project, Reading… 12s");
});

describe("at accessibility text sizes", () => {
  const window = Dimensions.get("window");
  const screen = Dimensions.get("screen");
  afterEach(() => act(() => Dimensions.set({ window, screen })));
  const flat = (node: { props: Record<string, any> }) => StyleSheet.flatten(node.props.style) ?? {};

  function expectTitleOnItsOwnLine(view: ReturnType<typeof render>) {
    // The waiting card's title gets a third line at these sizes; the row's
    // title a second, on a line of its own.
    const title = view.getByText("Fix the login redirect loop");
    expect(title.props.numberOfLines).toBeGreaterThanOrEqual(3);
    // Metadata sits on its own line and can no longer squeeze the title out.
    expect(view.getByText("project · Claude · w1:p1")).toBeTruthy();
    expect(view.getByLabelText("Waiting on you, Fix the login redirect loop, project, Claude")).toBeTruthy();
    expect(flat(view.getByText("Convert PDF exports")).flex ?? 0).toBe(0);
  }

  test("a waiting card and a row keep the conversation title at a cold launch", () => {
    act(() => Dimensions.set({ window: { ...window, fontScale: 3.12 }, screen }));
    expectTitleOnItsOwnLine(render(<Agents onOpenPane={jest.fn()} />));
  });

  // Jest's React Native preset starts at a font scale of 2, already over the
  // large-text threshold, so this starts at the default size explicitly:
  // started at 2 it never crossed it, and passed for rows that read the size
  // once at mount.
  test("a waiting card and a row keep the conversation title when the size changes while running", () => {
    act(() => Dimensions.set({ window: { ...window, fontScale: 1 }, screen }));
    const view = render(<Agents onOpenPane={jest.fn()} />);
    expect(view.getByText("Fix the login redirect loop").props.numberOfLines).toBe(2);
    expect(flat(view.getByText("Convert PDF exports")).flex).toBe(1);
    act(() => Dimensions.set({ window: { ...window, fontScale: 3.12 }, screen }));
    expectTitleOnItsOwnLine(view);
  });
});
