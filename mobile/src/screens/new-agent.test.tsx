import { render, screen, userEvent } from "@testing-library/react-native";
import { modesFor, type Session } from "@shahi/shared";
import { router } from "expo-router";
import { NewSpace, PickSpace } from "./spaces";

jest.mock("@/lib/api", () => ({ api: { createWorkspace: jest.fn(), dirs: jest.fn() } }));
import { api } from "@/lib/api";

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
    expect(claude[0]!.args).toEqual(["--permission-mode", "manual"]);
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
    expect(screen.getByText("Choose a space")).toBeTruthy();
    expect(screen.getByText("project")).toBeTruthy();
    expect(screen.getByText("notes")).toBeTruthy();
    await userEvent.press(screen.getByTestId("pick-w2"));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "w2", label: "notes" }));
  });

  test("offers a new space above the spaces that exist", async () => {
    const onNewSpace = jest.fn();
    render(<PickSpace session={session} onPick={jest.fn()} onNewSpace={onNewSpace} />);
    await userEvent.press(screen.getByTestId("pick-new-space"));
    expect(onNewSpace).toHaveBeenCalledTimes(1);
  });

  // Simulator run of build 32: VoiceOver read "1, tip-calc, ~/ShahiFresh/tip-calc".
  test("a space is named by its label and folder, not herdr's number", () => {
    render(<PickSpace session={session} onPick={jest.fn()} />);
    expect(screen.getByTestId("pick-w1").props.accessibilityLabel).toBe("project, ~/project");
    expect(screen.queryByText("1")).toBeNull();
    expect(screen.queryByText("2")).toBeNull();
  });

  test("with no spaces left, making one is still offered", async () => {
    const onNewSpace = jest.fn();
    render(<PickSpace session={{ ...session, workspaces: [] } as Session} onPick={jest.fn()} onNewSpace={onNewSpace} />);
    await userEvent.press(screen.getByTestId("pick-new-space"));
    expect(onNewSpace).toHaveBeenCalledTimes(1);
  });
});

/** The computer's home as `/api/dirs` lists it, folders only. */
const HOME: Record<string, unknown> = {
  "~": { path: "/home/you", display: "~", parent: null, entries: [
    { name: "projects", path: "/home/you/projects", display: "~/projects", isDirectory: true },
  ] },
  "~/projects": { path: "/home/you/projects", display: "~/projects", parent: "~", entries: [
    { name: "shahi", path: "/home/you/projects/shahi", display: "~/projects/shahi", isDirectory: true },
  ] },
  "~/projects/shahi": { path: "/home/you/projects/shahi", display: "~/projects/shahi", parent: "~/projects", entries: [] },
  "~/work/app": { path: "/home/you/work/app", display: "~/work/app", parent: "~/work", entries: [] },
};
const empty = { workspaces: [], tabs: [], panes: [] } as unknown as Session;

describe("NewSpace", () => {
  beforeEach(() => {
    (api.dirs as jest.Mock).mockReset().mockImplementation(async (path: string) => {
      if (!HOME[path]) throw new Error("no such folder");
      return HOME[path];
    });
    (api.createWorkspace as jest.Mock).mockReset();
  });

  // Device audit, build 28: the folder was a free-text absolute path, so a
  // first space anywhere new meant typing "/Users/…/…" on a phone keyboard.
  test("a folder is chosen by browsing, and the space is named after it", async () => {
    const createWorkspace = api.createWorkspace as jest.Mock;
    createWorkspace.mockResolvedValue({ workspaceId: "w9" });
    const onCreated = jest.fn();
    render(<NewSpace session={empty} onCreated={onCreated} />);

    expect(screen.getByTestId("create-space").props.accessibilityState.disabled).toBe(true);
    await userEvent.press(await screen.findByTestId("entry-projects"));
    await userEvent.press(await screen.findByTestId("entry-shahi"));
    await screen.findByText("No folders in here.");
    await userEvent.press(screen.getByTestId("use-folder"));

    expect(screen.getByTestId("chosen-folder")).toHaveTextContent(/~\/projects\/shahi/);
    expect(screen.getByPlaceholderText("what you are working on").props.value).toBe("shahi");
    await userEvent.press(screen.getByTestId("create-space"));
    // The absolute path: herdr does not expand `~`.
    expect(createWorkspace).toHaveBeenCalledWith({ label: "shahi", cwd: "/home/you/projects/shahi" });
    expect(onCreated).toHaveBeenCalledWith("w9");
  });

  // Simulator run of build 32: inside a folder, "Use this folder" under its
  // contents read as if the folder were already chosen.
  test("the choose button names the folder being viewed", async () => {
    render(<NewSpace session={empty} onCreated={jest.fn()} />);
    expect(await screen.findByText("Use your home folder")).toBeTruthy();
    await userEvent.press(await screen.findByTestId("entry-projects"));
    await screen.findByTestId("entry-shahi");
    expect(screen.getByTestId("use-folder")).toHaveTextContent(/Use projects/);
    expect(screen.getByTestId("create-space").props.accessibilityState.disabled).toBe(true);
  });

  // Simulator run of build 32: below a long home folder it was out of sight.
  test("typing a path is offered above the folder list, not below it", async () => {
    render(<NewSpace session={empty} onCreated={jest.fn()} />);
    await screen.findByTestId("entry-projects");
    const order = screen.root.findAll((node) => node.props.testID === "type-path" || node.props.testID === "folder-browser").map((node) => node.props.testID);
    expect(order[0]).toBe("type-path");
  });

  // Simulator run of build 32: New agent on a computer with no spaces met
  // the word "space" before anything said what it was.
  test("opened for a new agent, it says what a space is and that the agent comes next", async () => {
    render(<NewSpace session={empty} onCreated={jest.fn()} forAgent />);
    expect(screen.getByText("New agent")).toBeTruthy();
    expect(screen.getByText(/a folder on your computer/)).toBeTruthy();
    expect(screen.getByTestId("create-space")).toHaveTextContent("Create space and continue");
    // Nothing behind it to return to: Close leaves New agent.
    await userEvent.press(screen.getByTestId("sheet-close"));
    expect(router.back).toHaveBeenCalled();
    await screen.findByTestId("entry-projects");
  });

  test("a name the person typed is kept when a folder is chosen", async () => {
    render(<NewSpace session={empty} onCreated={jest.fn()} />);
    await userEvent.type(screen.getByPlaceholderText("what you are working on"), "release QA");
    await userEvent.press(await screen.findByTestId("entry-projects"));
    await screen.findByTestId("entry-shahi");
    await userEvent.press(screen.getByTestId("use-folder"));
    expect(screen.getByPlaceholderText("what you are working on").props.value).toBe("release QA");
  });

  // The attach sheet climbed with a folder row named "~", which reads as a folder.
  test("the way back is an Up row and a breadcrumb home, not a folder named ~", async () => {
    render(<NewSpace session={empty} onCreated={jest.fn()} />);
    await userEvent.press(await screen.findByTestId("entry-projects"));
    await userEvent.press(await screen.findByTestId("entry-shahi"));
    await screen.findByText("No folders in here.");
    expect(screen.queryByText("~")).toBeNull();
    await userEvent.press(screen.getByTestId("folder-up"));
    expect(await screen.findByTestId("entry-shahi")).toBeTruthy();
    await userEvent.press(screen.getByLabelText("Go to Home"));
    expect(await screen.findByTestId("entry-projects")).toBeTruthy();
    expect(screen.queryByTestId("folder-up")).toBeNull();
  });

  test("folders other spaces use are offered first, and open where they are", async () => {
    const session = { workspaces: [{ workspaceId: "w1", label: "app", cwd: "~/work/app", cwdPath: "/home/you/work/app" }], tabs: [], panes: [] } as unknown as Session;
    render(<NewSpace session={session} onCreated={jest.fn()} />);
    await userEvent.press(await screen.findByTestId("recent-~/work/app"));
    expect(api.dirs).toHaveBeenLastCalledWith("~/work/app", false);
    await userEvent.press(await screen.findByTestId("use-folder"));
    expect(screen.getByPlaceholderText("what you are working on").props.value).toBe("app");
  });

  // Build 29 on a phone: thirteen recent folders filled the screen and pushed
  // the folders to browse out of sight.
  test("only five recent folders show until the person asks for all of them", async () => {
    const workspaces = Array.from({ length: 8 }, (_, i) => ({ workspaceId: `w${i}`, label: `s${i}`, cwd: `~/work/s${i}`, cwdPath: `/home/you/work/s${i}` }));
    render(<NewSpace session={{ workspaces, tabs: [], panes: [] } as unknown as Session} onCreated={jest.fn()} />);
    await screen.findByTestId("entry-projects");
    expect(screen.getAllByTestId(/^recent-/)).toHaveLength(5);
    await userEvent.press(screen.getByLabelText("Show all 8 recent folders"));
    expect(screen.getAllByTestId(/^recent-/)).toHaveLength(8);
  });

  test("a brand-new box can still type its first folder and create a space", async () => {
    const createWorkspace = api.createWorkspace as jest.Mock;
    createWorkspace.mockResolvedValue({ workspaceId: "w1" });
    const onCreated = jest.fn();
    render(<NewSpace session={empty} onCreated={onCreated} />);

    expect(screen.getByTestId("create-space").props.accessibilityRole).toBe("button");
    expect(screen.getByTestId("create-space").props.accessibilityState.disabled).toBe(true);
    await userEvent.press(screen.getByTestId("type-path"));
    await userEvent.type(screen.getByTestId("new-space-folder"), "/tmp/shahi-first-space");
    await userEvent.clear(screen.getByPlaceholderText("what you are working on"));
    await userEvent.type(screen.getByPlaceholderText("what you are working on"), "production QA");
    await userEvent.press(screen.getByTestId("create-space"));

    expect(createWorkspace).toHaveBeenCalledWith({ label: "production QA", cwd: "/tmp/shahi-first-space" });
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  // Pre-release bug hunt, B9: a typo in the folder made a space in the home
  // directory, labelled with the folder that was meant. The computer now
  // refuses it, and the sheet shows its words and stays open to fix the path.
  test("a folder that is not on the computer is refused in words, and the sheet stays open", async () => {
    const createWorkspace = api.createWorkspace as jest.Mock;
    createWorkspace.mockRejectedValueOnce(new Error("That folder does not exist on this computer."));
    const onCreated = jest.fn();
    render(<NewSpace session={empty} onCreated={onCreated} />);

    await userEvent.press(screen.getByTestId("type-path"));
    await userEvent.type(screen.getByTestId("new-space-folder"), "/home/you/porject");
    await userEvent.press(screen.getByTestId("create-space"));

    expect(await screen.findByText("That folder does not exist on this computer.")).toBeTruthy();
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByTestId("create-space").props.accessibilityState.disabled).toBe(false);
  });
});

jest.mock("@/lib/session", () => ({ useSession: () => ({ api: require("@/lib/api").api }) }));
