import { render, screen, userEvent } from "@testing-library/react-native";
import { modesFor, type Session } from "@shahi/shared";
import { PickSpace } from "./spaces";

jest.mock("expo-router", () => ({ router: { back: jest.fn(), push: jest.fn(), replace: jest.fn() }, Stack: { Screen: () => null } }));
// The picker draws a plain numbered circle, not the working-state Avatar, but
// importing the screen pulls Reanimated in through it. The library's own mock
// still loads react-native-worklets, which needs native bindings a Linux Jest
// has not; a stub of just the surface Avatar imports keeps the module loadable.
jest.mock("react-native-reanimated", () => {
  const { View } = require("react-native");
  return {
    __esModule: true,
    default: { View },
    useSharedValue: (v: unknown) => ({ value: v }),
    useAnimatedStyle: () => ({}),
    useReducedMotion: () => true,
    withRepeat: (v: unknown) => v,
    withSequence: (v: unknown) => v,
    withTiming: (v: unknown) => v,
    cancelAnimation: () => undefined,
  };
});

/**
 * The permission picker, which is the one place on the phone where being wrong
 * is expensive rather than annoying: the wrong mode means an agent runs with
 * flags nobody chose.
 *
 * These assert against `shared/modes.ts` rather than against copied strings, so
 * adding a mode there cannot leave the phone silently offering the old set.
 */
describe("permission modes", () => {
  test("claude and codex offer different sets, and both have a safe default first", () => {
    const claude = modesFor("claude");
    const codex = modesFor("codex");

    expect(claude.length).toBeGreaterThan(1);
    expect(codex.length).toBeGreaterThan(1);
    expect(claude[0]!.unsafe).toBeFalsy();
    expect(codex[0]!.unsafe).toBeFalsy();
    expect(claude.map((m) => m.id)).not.toEqual(codex.map((m) => m.id));
  });

  // An unknown agent gets no options and starts with its own defaults. Inventing
  // a flag would mean an agent that refuses to start at all.
  test("an agent whose flags nobody checked is offered nothing", () => {
    expect(modesFor("some-new-agent")).toEqual([]);
    expect(modesFor(null)).toEqual([]);
  });

  test("exactly one mode per agent is the dangerous one", () => {
    for (const kind of ["claude", "codex"]) {
      expect(modesFor(kind).filter((m) => m.unsafe)).toHaveLength(1);
    }
  });
});

describe("PickSpace", () => {
  const session = {
    workspaces: [
      { workspaceId: "w1", label: "project", cwd: "~/project", status: "blocked", tabCount: 3, paneCount: 3 },
      { workspaceId: "w2", label: "notes", cwd: "~/notes", status: "idle", tabCount: 1, paneCount: 1 },
    ],
    tabs: [],
    panes: [],
  } as unknown as Session;

  test("lists every space and hands back the one tapped", async () => {
    const onPick = jest.fn();
    render(<PickSpace session={session} onPick={onPick} />);
    expect(screen.getByText("project")).toBeTruthy();
    expect(screen.getByText("notes")).toBeTruthy();
    await userEvent.press(screen.getByTestId("pick-w2"));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "w2", label: "notes" }));
  });

  test("with no spaces, offers to make one instead of an empty list", () => {
    render(<PickSpace session={{ ...session, workspaces: [] } as Session} onPick={jest.fn()} />);
    expect(screen.getByText(/make one first/)).toBeTruthy();
  });
});
