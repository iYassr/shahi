import { act, render } from "@testing-library/react-native";
import { Dimensions, StyleSheet } from "react-native";
import type { DashboardPane, Session, Space } from "@shahi/shared";
import { PickSpace, SpaceDetail } from "./spaces";

const space = { workspaceId: "w1", label: "Project", cwd: "~/project", cwdPath: "/work/project", status: "blocked" } as Space;
const pane: DashboardPane = {
  paneId: "w1:p1", status: "blocked", workspaceId: "w1", workspaceLabel: "Project", tabId: "t1", agent: "claude",
  title: "Fix the login redirect loop", cwd: "/work/project", focused: false, hasPrompt: true, isAgent: true,
  prompt: null, preview: "Allow this edit?", activity: null,
};
const session = { workspaces: [space], tabs: [{ tabId: "t1", workspaceId: "w1", label: "1" }], panes: [pane] } as unknown as Session;

jest.mock("@/lib/session", () => ({ useSession: () => ({ api: {}, session: null, link: "live" }) }));
jest.mock("@/components/avatar", () => ({ Avatar: () => null }));
jest.mock("@/components/connection-health", () => ({ ConnectionHealth: () => null }));
jest.mock("@/lib/scroll-memory", () => ({ useRememberedScroll: () => ({}) }));
jest.mock("react-native-safe-area-context", () => ({ SafeAreaView: require("react-native").View }));
jest.mock("expo-router", () => ({ router: { back: jest.fn(), push: jest.fn(), replace: jest.fn() }, Stack: { Screen: () => null } }));

const flat = (node: { props: Record<string, any> }) => StyleSheet.flatten(node.props.style) ?? {};

describe("a space's conversation rows at accessibility text sizes", () => {
  const window = Dimensions.get("window");
  const screen = Dimensions.get("screen");
  afterEach(() => act(() => Dimensions.set({ window, screen })));

  // The status word and agent label cannot shrink; beside them the title got
  // no width at all (September 2026 review).
  function expectTitleKept(view: ReturnType<typeof render>) {
    const title = view.getByText("Fix the login redirect loop");
    expect(title.props.numberOfLines).toBeGreaterThanOrEqual(2);
    expect(flat(title).flex ?? 0).toBe(0);
    const meta = view.getByText("Claude");
    expect(meta.props.numberOfLines).toBe(1);
    expect(flat(meta).flexShrink).toBe(1);
  }

  test("keep the conversation title at a cold launch", () => {
    act(() => Dimensions.set({ window: { ...window, fontScale: 3.12 }, screen }));
    expectTitleKept(render(<SpaceDetail space={space} session={session} />));
  });

  // Jest's React Native preset starts at a font scale of 2, already over the
  // large-text threshold, so this starts at the default size explicitly:
  // started at 2 it never crossed it, and passed for rows that read the size
  // once at mount.
  test("keep the conversation title when the size changes while running", () => {
    act(() => Dimensions.set({ window: { ...window, fontScale: 1 }, screen }));
    const view = render(<SpaceDetail space={space} session={session} />);
    expect(flat(view.getByText("Fix the login redirect loop")).flex).toBe(1);
    act(() => Dimensions.set({ window: { ...window, fontScale: 3.12 }, screen }));
    expectTitleKept(view);
  });
});

test("a space's conversation row says each fact once, title first", () => {
  const view = render(<SpaceDetail space={space} session={session} />);
  expect(view.getByLabelText("Fix the login redirect loop, Claude, blocked, Allow this edit?")).toBeTruthy();
});

// hitSlop widens where a finger lands, not the element VoiceOver and Switch
// Control focus: the simulator measured that one at 39×18pt.
test("the choose-a-space Close button is a 44-point target of its own", () => {
  const view = render(<PickSpace session={session} onPick={jest.fn()} />);
  const close = view.getByTestId("sheet-close");
  expect(close.props.hitSlop).toBeUndefined();
  expect(flat(close).minWidth).toBeGreaterThanOrEqual(44);
  expect(flat(close).minHeight).toBeGreaterThanOrEqual(44);
});
