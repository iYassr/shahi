import { clearNativeDrafts } from "@/lib/drafts";
import { act, fireEvent, render, within } from "@testing-library/react-native";
import type { LogMessage, PaneCommands, PromptReceipt, SessionLog } from "@shahi/shared";
import { StyleSheet } from "react-native";
import { api, UnauthorizedError } from "@/lib/api";
import { forgetPaneMemory, Pane } from "./pane";

/**
 * The composer's shortcuts, asked for by the owner in October 2026: a picker
 * for an agent's slash commands, and one-tap replies while it waits. Typing
 * `/compact` on a phone keyboard is a trip to the symbols layer, and the
 * commonest replies are a few words. Each test is named after what a person
 * would notice going wrong.
 */

jest.setTimeout(30_000);

const PANE = "w1:p1";
jest.mock("@/lib/diagnostics", () => ({ diagnosticsEnabled: () => false, reportReaderIncident: () => {} }));

const mockSession = {
  link: "live", error: null, server: "relay://example", reconnect: jest.fn(async () => {}),
  session: { panes: [] as Record<string, unknown>[] },
  terminalWidth: 100,
  watch: jest.fn(),
  unauthorized: jest.fn(),
  control: undefined as { handshake: unknown; refresh: () => void } | undefined,
  onPaneFrame: () => () => {},
};
jest.mock("@/lib/session", () => ({ useSession: () => ({ ...mockSession, api: require("@/lib/api").api, transport: require("@/lib/api").connection, computers: [] }) }));
jest.mock("@/lib/api", () => {
  const actual = jest.requireActual("@/lib/api");
  return { ...actual, api: { sessionLog: jest.fn(), pane: jest.fn(), send: jest.fn(), sendKeys: jest.fn(), answerPrompt: jest.fn(), paneCommands: jest.fn() } };
});
jest.mock("@/lib/dictation", () => ({
  ...jest.requireActual("@/lib/dictation"),
  dictation: { availability: async () => ({ available: false, installed: true }), install: async () => {}, start: async () => {}, finish: async () => "", cancel: async () => {}, listen: () => ({ remove: () => {} }) },
}));
jest.mock("expo-router", () => ({
  useIsFocused: () => true,
  useFocusEffect: (effect: () => void) => require("react").useEffect(effect, [effect]),
  Stack: { Screen: () => null },
}));
jest.mock("expo-router/react-navigation", () => ({ useHeaderHeight: () => 0 }));
jest.mock("@/lib/keyboard", () => ({ useKeyboardHeight: () => 0 }));

const mocked = api as unknown as { sessionLog: jest.Mock; pane: jest.Mock; send: jest.Mock; paneCommands: jest.Mock };

const settle = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
const said = (id: string, role: LogMessage["role"], text: string): LogMessage => ({ id, role, at: 1, blocks: [{ kind: "text", text }] });
const log = (messages: LogMessage[]): SessionLog => ({ sessionId: "s1", path: "/home/x/.claude/projects/s1.jsonl", messages, total: messages.length, offset: 0 });
const receipt: PromptReceipt = { accepted: true, clientMessageId: "c1", acceptedAt: 1 };
const handshake = (capabilities: string[]) => ({
  control: 1, serverId: "s", api: { min: 5, max: 5 }, capabilities,
  backend: { state: "connected", version: "0.9.1", protocol: 22 }, update: { managed: false, channel: "stable", phase: "idle", current: "dev" },
});

/** An agent pane as the dashboard lists it. */
function agentPane(patch: Record<string, unknown> = {}) {
  mockSession.session.panes = [{ paneId: PANE, title: "A task", agent: "claude", isAgent: true, status: "idle", hasPrompt: false, instanceId: "occupant-1", ...patch }];
}
const composer = (view: ReturnType<typeof render>) => view.getByPlaceholderText("Reply to this agent…");

beforeEach(() => {
  clearNativeDrafts(api);
  forgetPaneMemory(api, PANE);
  jest.useFakeTimers();
  mockSession.control = undefined;
  mockSession.link = "live";
  mockSession.unauthorized.mockReset();
  for (const fn of Object.values(mocked)) fn.mockReset();
  mocked.pane.mockResolvedValue({ frame: null, layout: null });
  mocked.send.mockResolvedValue(receipt);
  mocked.sessionLog.mockResolvedValue(log([said("a1", "agent", "I fixed the parser. Shall I run the tests?")]));
  agentPane();
});

describe("the slash-command picker", () => {
  test("typing / lists the agent's commands, typing on filters them, and choosing one fills the reply without sending it", async () => {
    const view = render(<Pane paneId={PANE} />);
    await view.findByText(/Shall I run the tests/);
    expect(view.queryByTestId("command-picker")).toBeNull();

    fireEvent.changeText(composer(view), "/");
    const picker = within(view.getByTestId("command-picker"));
    expect(picker.getByText("/compact")).toBeTruthy();
    expect(picker.getByText("/clear")).toBeTruthy();

    fireEvent.changeText(composer(view), "/co");
    const filtered = within(view.getByTestId("command-picker"));
    expect(filtered.getByText("/compact")).toBeTruthy();
    expect(filtered.getByText("/context")).toBeTruthy();
    expect(filtered.queryByText("/clear")).toBeNull();

    fireEvent.press(filtered.getByLabelText(/^\/compact, /));
    expect(composer(view).props.value).toBe("/compact ");
    // The space closes it: what follows is the command's arguments.
    expect(view.queryByTestId("command-picker")).toBeNull();
    expect(mocked.send).not.toHaveBeenCalled();

    fireEvent.press(view.getByText("Send"));
    await settle();
    expect(mocked.send).toHaveBeenCalledWith(PANE, "/compact", expect.any(String), "occupant-1");
  });

  test("a path typed first, /Users/…, is not taken for a command being looked for", async () => {
    const view = render(<Pane paneId={PANE} />);
    await view.findByText(/Shall I run the tests/);
    fireEvent.changeText(composer(view), "/Users/me/notes.md");
    expect(view.queryByTestId("command-picker")).toBeNull();
  });

  test("a shell and the Screen view get no picker: there a slash is the terminal's", async () => {
    agentPane({ agent: null, isAgent: false });
    const shell = render(<Pane paneId={PANE} />);
    await settle();
    fireEvent.changeText(shell.getByPlaceholderText("Run a command…"), "/");
    expect(shell.queryByTestId("command-picker")).toBeNull();
    shell.unmount();

    agentPane();
    const view = render(<Pane paneId={PANE} />);
    await view.findByText(/Shall I run the tests/);
    fireEvent.press(view.getByTestId("view-screen"));
    fireEvent.changeText(view.getByPlaceholderText("Send text to terminal…"), "/");
    expect(view.queryByTestId("command-picker")).toBeNull();
  });

  test("a computer that lists commands adds the person's own; one that cannot is never asked", async () => {
    const listed: PaneCommands = { commands: [
      { name: "compact", description: "Clear conversation history but keep a summary in context", source: "builtin" },
      { name: "frontend:component", description: "Make a component", source: "project" },
      { name: "standup", description: "Write my standup", source: "user" },
    ] };
    mocked.paneCommands.mockResolvedValue(listed);

    const old = render(<Pane paneId={PANE} />);
    await old.findByText(/Shall I run the tests/);
    fireEvent.changeText(composer(old), "/");
    await settle();
    expect(mocked.paneCommands).not.toHaveBeenCalled();
    expect(within(old.getByTestId("command-picker")).getByText("/compact")).toBeTruthy();
    old.unmount();

    mockSession.control = { handshake: handshake(["sessions", "commands"]), refresh: () => {} };
    const view = render(<Pane paneId={PANE} />);
    await view.findByText(/Shall I run the tests/);
    fireEvent.changeText(composer(view), "/");
    await settle();
    expect(mocked.paneCommands).toHaveBeenCalledWith(PANE);
    const picker = within(view.getByTestId("command-picker"));
    expect(picker.getByText("/standup")).toBeTruthy();
    expect(picker.getByText("personal")).toBeTruthy();
    expect(picker.getByText("project")).toBeTruthy();

    // `comp` finds a namespaced command by its last part, too.
    fireEvent.changeText(composer(view), "/comp");
    fireEvent.press(within(view.getByTestId("command-picker")).getByLabelText(/^\/frontend:component, /));
    expect(composer(view).props.value).toBe("/frontend:component ");
  });

  test("a 401 while listing commands is handed to the session, which decides whether access ended", async () => {
    mockSession.control = { handshake: handshake(["commands"]), refresh: () => {} };
    mocked.paneCommands.mockRejectedValue(new UnauthorizedError());
    const view = render(<Pane paneId={PANE} />);
    await view.findByText(/Shall I run the tests/);
    fireEvent.changeText(composer(view), "/");
    await settle();
    expect(mockSession.unauthorized).toHaveBeenCalled();
    // The built-ins stay: the person can still pick one.
    expect(within(view.getByTestId("command-picker")).getByText("/compact")).toBeTruthy();
  });
});

describe("quick replies", () => {
  test("an idle agent with a conversation offers the replies and /, each a 44-point target with its own name", async () => {
    const view = render(<Pane paneId={PANE} />);
    await view.findByText(/Shall I run the tests/);
    const chips = within(view.getByTestId("reply-chips"));
    for (const label of ["Commands", "Continue", "Yes, go ahead", "Explain that more simply", "Summarize what you changed"]) {
      const chip = chips.getByLabelText(label);
      expect(chip.props.accessibilityRole).toBe("button");
      expect(StyleSheet.flatten(chip.props.style)).toMatchObject({ minHeight: 44, minWidth: 44 });
    }
    expect(chips.getByLabelText("Continue").props.accessibilityHint).toBe("Sends this reply now");
  });

  test("a reply is sent the moment it is tapped, with an operation id and the occupant, and echoed like a typed one", async () => {
    const view = render(<Pane paneId={PANE} />);
    await view.findByText(/Shall I run the tests/);
    fireEvent.press(within(view.getByTestId("reply-chips")).getByLabelText("Yes, go ahead"));
    await settle();
    expect(mocked.send).toHaveBeenCalledTimes(1);
    expect(mocked.send).toHaveBeenCalledWith(PANE, "Yes, go ahead", expect.any(String), "occupant-1");
    expect(view.getByText("YOU")).toBeTruthy();
    expect(composer(view).props.value).toBe("");
  });

  test("after a reply the chips stay away until the agent has answered, so a second tap cannot send it twice", async () => {
    let transcript = [said("a1", "agent", "I fixed the parser. Shall I run the tests?")];
    mocked.sessionLog.mockImplementation(async () => log(transcript));
    const view = render(<Pane paneId={PANE} />);
    await view.findByText(/Shall I run the tests/);
    fireEvent.press(within(view.getByTestId("reply-chips")).getByLabelText("Yes, go ahead"));
    await settle();
    // Accepted, and herdr still says idle: the agent has not started yet.
    expect(view.queryByTestId("reply-chips")).toBeNull();
    transcript = [...transcript, said("u1", "you", "Yes, go ahead"), said("a2", "agent", "All 184 tests pass.")];
    await act(async () => { jest.advanceTimersByTime(6_000); });
    await view.findByText(/All 184 tests pass/);
    await settle();
    expect(view.getByTestId("reply-chips")).toBeTruthy();
  });

  test("a slash command is not left showing Working: it answers at once or shows its own activity", async () => {
    const view = render(<Pane paneId={PANE} />);
    await view.findByText(/Shall I run the tests/);
    fireEvent.changeText(composer(view), "/con");
    fireEvent.press(within(view.getByTestId("command-picker")).getByLabelText(/^\/context, /));
    fireEvent.press(view.getByText("Send"));
    await settle();
    expect(mocked.send).toHaveBeenCalledWith(PANE, "/context", expect.any(String), "occupant-1");
    expect(view.queryByText("Working")).toBeNull();
    // Briefly away, in case the agent is about to start; back once it has not.
    expect(view.queryByTestId("reply-chips")).toBeNull();
    await act(async () => { jest.advanceTimersByTime(5_100); });
    expect(view.getByTestId("reply-chips")).toBeTruthy();
  });

  test("a reply whose delivery is uncertain lands in the composer, and Send retries it under the same id", async () => {
    mocked.send.mockRejectedValueOnce(new Error("connection interrupted")).mockResolvedValue(receipt);
    const view = render(<Pane paneId={PANE} />);
    await view.findByText(/Shall I run the tests/);
    fireEvent.press(within(view.getByTestId("reply-chips")).getByLabelText("Continue"));
    await view.findByText("connection interrupted");
    expect(composer(view).props.value).toBe("Continue");
    expect(view.getByTestId("unconfirmed-send")).toBeTruthy();
    fireEvent.press(view.getByText("Send"));
    await settle();
    expect(mocked.send.mock.calls[1]![2]).toBe(mocked.send.mock.calls[0]![2]);
  });

  test("a typed draft is never replaced or discarded by a chip: the chips go while it is there", async () => {
    const view = render(<Pane paneId={PANE} />);
    await view.findByText(/Shall I run the tests/);
    fireEvent.changeText(composer(view), "only run the parser tests");
    expect(view.queryByTestId("reply-chips")).toBeNull();
    expect(composer(view).props.value).toBe("only run the parser tests");
    fireEvent.changeText(composer(view), "");
    expect(view.getByTestId("reply-chips")).toBeTruthy();
  });

  test("the / chip starts a command in the reply box", async () => {
    const view = render(<Pane paneId={PANE} />);
    await view.findByText(/Shall I run the tests/);
    fireEvent.press(within(view.getByTestId("reply-chips")).getByLabelText("Commands"));
    expect(composer(view).props.value).toBe("/");
    expect(view.getByTestId("command-picker")).toBeTruthy();
    expect(mocked.send).not.toHaveBeenCalled();
  });

  test("nothing is offered while the agent works, asks a choice, or is a shell", async () => {
    agentPane({ status: "working" });
    let view = render(<Pane paneId={PANE} />);
    await view.findByText(/Shall I run the tests/);
    expect(view.queryByTestId("reply-chips")).toBeNull();
    view.unmount();

    agentPane({ status: "blocked", hasPrompt: true });
    mocked.pane.mockResolvedValue({ frame: { paneId: PANE, ansi: "", text: "", activity: null, at: 1,
      prompt: { question: "Run this command?", options: [{ index: 1, label: "Yes", selected: true }, { index: 2, label: "No", selected: false }] } }, layout: null });
    view = render(<Pane paneId={PANE} />);
    await view.findByText("Run this command?");
    expect(view.queryByTestId("reply-chips")).toBeNull();
    view.unmount();

    // herdr can call an agent idle while a menu waits (provider-prompts.ts);
    // the card is what counts.
    agentPane({ status: "idle", hasPrompt: false });
    view = render(<Pane paneId={PANE} />);
    await view.findByText("Run this command?");
    expect(view.queryByTestId("reply-chips")).toBeNull();
    view.unmount();

    mocked.pane.mockResolvedValue({ frame: null, layout: null });
    agentPane({ agent: null, isAgent: false });
    view = render(<Pane paneId={PANE} />);
    await settle();
    expect(view.queryByTestId("reply-chips")).toBeNull();
  });

  test("a finished agent is waiting too, and a new one with nothing said yet is offered only /", async () => {
    agentPane({ status: "done" });
    let view = render(<Pane paneId={PANE} />);
    await view.findByText(/Shall I run the tests/);
    expect(within(view.getByTestId("reply-chips")).getByLabelText("Continue")).toBeTruthy();
    view.unmount();

    mocked.sessionLog.mockResolvedValue(log([]));
    forgetPaneMemory(api, PANE);
    agentPane({ status: "idle" });
    view = render(<Pane paneId={PANE} />);
    await settle();
    const chips = within(view.getByTestId("reply-chips"));
    expect(chips.getByLabelText("Commands")).toBeTruthy();
    expect(chips.queryByLabelText("Continue")).toBeNull();
  });

  test("offline, no reply is offered that could not be sent", async () => {
    mockSession.link = "lost";
    const view = render(<Pane paneId={PANE} />);
    await view.findByText(/Shall I run the tests/);
    expect(view.queryByTestId("reply-chips")).toBeNull();
  });

  test("an agent nobody measured gets the replies but no / chip", async () => {
    agentPane({ agent: "gemini" });
    const view = render(<Pane paneId={PANE} />);
    await view.findByText(/Shall I run the tests/);
    const chips = within(view.getByTestId("reply-chips"));
    expect(chips.queryByLabelText("Commands")).toBeNull();
    expect(chips.getByLabelText("Continue")).toBeTruthy();
  });
});
