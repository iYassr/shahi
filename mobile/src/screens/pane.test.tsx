import { clearNativeDrafts } from "@/lib/drafts";
import { act, fireEvent, render, waitFor, within } from "@testing-library/react-native";
import { Dimensions, FlatList, StyleSheet, View } from "react-native";
import { createElement } from "react";
import type { LogBlock, LogMessage, ParsedPrompt, PromptReceipt, SessionLog } from "@shahi/shared";
import { api, ApiError, connection, UnauthorizedError, UnreachableError } from "@/lib/api";
import { FileDownloadError } from "@shahi/shared/file-download";
import { forgetPaneMemory, paneScrollPlace, Pane } from "./pane";

// The first test in this file pays for loading the screen and its mocks under
// fake timers, and GitHub's ubuntu runner took more than Jest's 5s default
// for it (a cold run of the whole file was 8.8s there; it is ~1s here). A
// generous ceiling, not a wait: a passing test still finishes in the same time.
jest.setTimeout(30_000);

/**
 * The reader's behaviour, which until now was proven by hand on a phone.
 *
 * Every test here is named after a symptom that was reported or a rule that
 * costs a report when broken: the reply that only appeared after a poll, the
 * spinner that showed out of a silence, the busy pane with several identical
 * fetches in flight, the 401 that left a pane polling forever under a LIVE
 * badge, the remembered place that was thrown away before anything loaded.
 *
 * The server is `@/lib/api`, mocked per test so a transcript can be changed
 * between loads; the session context is a plain object with a working
 * `onPaneFrame`, so a test can push a `log_changed` the way the socket does.
 */

const PANE = "w1:p1";

/*
 * `mock`-prefixed on purpose: jest hoists `jest.mock` above the imports, so
 * the factory can only close over names it will read later, at render time —
 * and jest only permits that for variables named `mock*`.
 */
const mockFrameListeners = new Map<string, Set<() => void>>();
const mockSession = {
  link: "live", error: null, server: "relay://example", reconnect: jest.fn(async () => {}),
  session: {
    panes: [{ paneId: PANE, title: "A task", agent: "claude", isAgent: true }],
  },
  terminalWidth: 100,
  watch: jest.fn(),
  unauthorized: jest.fn(),
  onPaneFrame: (paneId: string, cb: () => void) => {
    let set = mockFrameListeners.get(paneId);
    if (!set) {
      set = new Set();
      mockFrameListeners.set(paneId, set);
    }
    set.add(cb);
    return () => {
      set!.delete(cb);
    };
  },
};

/**
 * The computer on screen. Each ComputerSession owns one API object, so a test
 * shows another computer by handing the screen a different one.
 */
const mockComputer: { api?: object } = {};
jest.mock("@/lib/session", () => ({ useSession: () => ({ ...mockSession, api: mockComputer.api ?? require("@/lib/api").api, transport: require("@/lib/api").connection, computers: [] }) }));

// The real error classes are kept: `instanceof UnauthorizedError` is the
// sign-out decision under test, and a fake class would prove nothing.
jest.mock("@/lib/api", () => {
  const actual = jest.requireActual("@/lib/api");
  return {
    ...actual,
    api: {
      sessionLog: jest.fn(),
      pane: jest.fn(),
      send: jest.fn(),
      sendKeys: jest.fn(),
      readFile: jest.fn(),
      dirs: jest.fn(),
      answerPrompt: jest.fn(),
      transcriptImage: jest.fn(),
    },
  };
});

// Neither the native header nor the keyboard exists here, and the screen
// options are set on a navigator this test does not mount.
jest.mock("expo-router", () => ({ Stack: { Screen: () => null } }));
jest.mock("expo-router/react-navigation", () => ({ useHeaderHeight: () => 0 }));
jest.mock("@/lib/keyboard", () => ({ useKeyboardHeight: () => 0 }));

const mocked = api as unknown as {
  sessionLog: jest.Mock;
  pane: jest.Mock;
  send: jest.Mock;
  sendKeys: jest.Mock;
  transcriptImage: jest.Mock;
};

/** What the socket does when the server says this pane has something new. */
function logChanged(paneId = PANE) {
  act(() => {
    mockFrameListeners.get(paneId)?.forEach((fn) => fn());
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every settled promise run its continuations, inside React's act. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });

const said = (id: string, role: LogMessage["role"], text: string): LogMessage => ({
  id,
  role,
  at: 1,
  blocks: [{ kind: "text", text }],
});
const log = (messages: LogMessage[]): SessionLog => ({
  sessionId: "s1",
  path: "/home/x/.claude/projects/s1.jsonl",
  messages,
  total: messages.length,
  offset: 0,
});
const detail = (activity: { verb: string } | null = null) => ({
  frame: activity
    ? { paneId: PANE, ansi: "", text: "", prompt: null, activity: { ...activity, elapsed: "", detail: null }, at: 1 }
    : null,
  layout: null,
});
const receipt: PromptReceipt = { accepted: true, clientMessageId: "c1", acceptedAt: 1 };

beforeEach(() => {
  clearNativeDrafts(api);
  // The reader remembers each computer's conversations for the life of the
  // process, so a test starts from a pane this computer has never shown.
  forgetPaneMemory(api, PANE);
  mockComputer.api = undefined;
  // Fake timers for the whole file, never switched mid-file: a run that
  // faked them in one test and not the next hung outright, as a list timer
  // scheduled under one clock was awaited under the other. RNTL's `waitFor`
  // advances fake timers itself, so the reader's own poll still fires where a
  // test waits for it — and the 4s restore backstop never becomes a real one
  // holding the runner open.
  jest.useFakeTimers();
  mockFrameListeners.clear();
  mockSession.watch.mockReset();
  mockSession.unauthorized.mockReset();
  for (const fn of Object.values(mocked)) fn.mockReset();
  mocked.pane.mockResolvedValue(detail());
  mocked.send.mockResolvedValue(receipt);
});

describe("sending a reply", () => {
  test("your reply is echoed into the thread the instant you send, and the echo is retired when the transcript has it", async () => {
    let transcript = [said("a1", "agent", "What should I do next?")];
    let loads = 0;
    mocked.sessionLog.mockImplementation(async () => {
      loads++;
      return log(transcript);
    });
    // The send never returns during the first assertions: the echo must not
    // be waiting on it.
    const send = deferred<PromptReceipt>();
    mocked.send.mockReturnValue(send.promise);

    const view = render(<Pane paneId={PANE} />);
    await view.findByText(/What should I do next\?/);

    fireEvent.changeText(view.getByPlaceholderText("Reply to this agent…"), "ship it");
    fireEvent.press(view.getByText("Send"));

    expect(view.getByText(/ship it/)).toBeTruthy();
    expect(view.getAllByText("YOU")).toHaveLength(1);
    // No occupant: this session is from a server that names none.
    expect(mocked.send).toHaveBeenCalledWith(PANE, "ship it", expect.any(String), undefined);
    // The composer is cleared with the tap, not with the receipt.
    expect(view.getByPlaceholderText("Reply to this agent…").props.value).toBe("");
    expect(view.getByPlaceholderText("Reply to this agent…").props.editable).toBe(false);

    // The real `you` message lands in the transcript, on its own — no agent
    // reply yet — and the server says the log changed.
    transcript = [...transcript, said("u1", "you", "ship it")];
    send.resolve(receipt);
    const before = loads;
    logChanged();
    await waitFor(() => expect(loads).toBeGreaterThan(before));
    await settle();

    // One "ship it", not the echo beside the real one — and not zero.
    expect(view.getAllByText(/ship it/)).toHaveLength(1);
    expect(view.getAllByText("YOU")).toHaveLength(1);
  });

  test("a send that fails pulls the echo back and returns the text to the composer", async () => {
    mocked.sessionLog.mockResolvedValue(log([said("a1", "agent", "Ready.")]));
    mocked.send.mockRejectedValue(new Error("herdr said no"));

    const view = render(<Pane paneId={PANE} />);
    await view.findByText(/Ready\./);
    fireEvent.changeText(view.getByPlaceholderText("Reply to this agent…"), "ship it");
    fireEvent.press(view.getByText("Send"));

    await view.findByText("herdr said no");
    expect(view.queryByText("YOU")).toBeNull();
    expect(view.getByPlaceholderText("Reply to this agent…").props.value).toBe("ship it");
    expect(view.getByPlaceholderText("Reply to this agent…").props.editable).toBe(true);
    expect(view.queryByText("Working")).toBeNull();
  });

  test("working shows the instant you send and ends when a new agent message lands", async () => {
    let transcript = [said("a1", "agent", "Ready when you are.")];
    let loads = 0;
    mocked.sessionLog.mockImplementation(async () => {
      loads++;
      return log(transcript);
    });

    const view = render(<Pane paneId={PANE} />);
    await view.findByText(/Ready when you are\./);
    expect(view.queryByText("Working")).toBeNull();

    fireEvent.changeText(view.getByPlaceholderText("Reply to this agent…"), "go");
    fireEvent.press(view.getByText("Send"));
    // Synchronously with the tap — no poll has had a chance to run.
    expect(view.getByText("Working")).toBeTruthy();

    // Your own message arriving is not the agent replying: still working.
    transcript = [...transcript, said("u1", "you", "go")];
    let before = loads;
    logChanged();
    await waitFor(() => expect(loads).toBeGreaterThan(before));
    await settle();
    expect(view.getByText("Working")).toBeTruthy();

    transcript = [...transcript, said("a2", "agent", "Done: shipped.")];
    before = loads;
    logChanged();
    await view.findByText(/Done: shipped\./);
    expect(view.queryByText("Working")).toBeNull();
  });

  // Three states the web reader has always shown and the native one dropped.
  // All three rendered as an empty expansion, so a call that returned nothing,
  // a call whose output was cut, and a call still running looked identical.
  describe("tool result states", () => {
    type ToolResult = (LogBlock & { kind: "tool" })["result"];
    const ranTool = (result: ToolResult): LogMessage => ({
      id: "t1",
      role: "agent",
      at: 1,
      blocks: [{ kind: "tool", name: "Bash", summary: "ls", result }],
    });
    /** The tool row is collapsed by default; its name is the toggle. */
    const expand = async (result: ToolResult) => {
      mocked.sessionLog.mockResolvedValue(log([ranTool(result)]));
      const view = render(<Pane paneId={PANE} />);
      fireEvent.press(await view.findByText("Bash"));
      return view;
    };

    test("says a truncated result was cut, rather than ending mid-output", async () => {
      const view = await expand({ text: "line one", isError: false, truncated: true, images: [] });
      expect(view.getByText(/… truncated/)).toBeTruthy();
    });

    test("does not claim truncation when the result is whole", async () => {
      const view = await expand({ text: "line one", isError: false, truncated: false, images: [] });
      expect(view.queryByText(/… truncated/)).toBeNull();
    });

    test("says a call that returned nothing returned nothing", async () => {
      const view = await expand({ text: "   ", isError: false, truncated: false, images: [] });
      expect(view.getByText("(no output)")).toBeTruthy();
    });

    test("says a call with no result yet is still running", async () => {
      const view = await expand(null);
      expect(view.getByText("Still running.")).toBeTruthy();
      expect(view.queryByText("(no output)")).toBeNull();
    });
  });

  // September 2026 pre-release bug hunt: the viewer replaced every message but
  // "Preview unavailable…" with "may have moved, or your computer may be
  // offline", so a folder, a file outside home, a file over 25 MB and a
  // computer that needs an update all looked like a dead connection.
  describe("the file viewer", () => {
    const opened = async (failure: Error) => {
      (api as unknown as { readFile: jest.Mock }).readFile.mockRejectedValue(failure);
      mocked.sessionLog.mockResolvedValue(log([{
        id: "t1", role: "agent", at: 1,
        blocks: [{ kind: "tool", name: "Read", summary: "~/project", file: { path: "/home/x/project", name: "project" }, result: null }],
      }]));
      const view = render(<Pane paneId={PANE} />);
      fireEvent.press(await view.findByText("project"));
      return view;
    };

    test("says the computer's reason for refusing a file, not that the computer may be offline", async () => {
      const view = await opened(new FileDownloadError("That is a folder, not a file."));
      expect(await view.findByText("That is a folder, not a file.")).toBeTruthy();
      expect(view.queryByText(/may be offline/)).toBeNull();
    });

    test("keeps 'may be offline' for a request that got no answer", async () => {
      const view = await opened(new UnreachableError("box", "relay.example", "Your computer is offline — its Shahi service is not connected to the relay."));
      expect(await view.findByText(/your computer may be offline/)).toBeTruthy();
    });
  });

  // Pasted Python or YAML lost its first line's indentation relative to the
  // rest, because the whole draft was trimmed (pre-release bug hunt).
  test("a message keeps its first line's indentation", async () => {
    mocked.sessionLog.mockResolvedValue(log([said("a1", "agent", "Paste the function.")]));
    const view = render(<Pane paneId={PANE} />);
    await view.findByText(/Paste the function\./);
    fireEvent.changeText(view.getByPlaceholderText("Reply to this agent…"), "\n  \n    def f():\n        return 1\n\n");
    fireEvent.press(view.getByText("Send"));
    expect(mocked.send).toHaveBeenCalledWith(PANE, "    def f():\n        return 1", expect.any(String));
  });

  test("a draft of only spaces and newlines is not sent", async () => {
    mocked.sessionLog.mockResolvedValue(log([said("a1", "agent", "Ready.")]));
    const view = render(<Pane paneId={PANE} />);
    await view.findByText(/Ready\./);
    fireEvent.changeText(view.getByPlaceholderText("Reply to this agent…"), "  \n\t ");
    fireEvent.press(view.getByText("Send"));
    expect(mocked.send).not.toHaveBeenCalled();
  });

  // Typing "ls" on the phone's keyboard sent "Ls", which a shell rejects: the
  // composer took iOS's defaults of sentence capitals and autocorrect, meant
  // for prose, for terminal input too (pre-release bug hunt).
  describe("terminal input is typed literally", () => {
    const literal = { autoCapitalize: "none", autoCorrect: false, spellCheck: false, smartInsertDelete: false };

    test("in a shell pane", async () => {
      const panes = mockSession.session.panes;
      mockSession.session.panes = [{ paneId: "w1:p-shell", title: "zsh", agent: null as unknown as string, isAgent: false }];
      try {
        mocked.sessionLog.mockRejectedValue(new Error("no transcript"));
        const view = render(<Pane paneId="w1:p-shell" />);
        await settle();
        expect(view.getByPlaceholderText("Run a command…").props).toMatchObject(literal);
        view.unmount();
      } finally {
        mockSession.session.panes = panes;
        forgetPaneMemory(api, "w1:p-shell");
      }
    });

    test("on an agent's Screen", async () => {
      mocked.sessionLog.mockResolvedValue(log([said("a1", "agent", "Ready.")]));
      const view = render(<Pane paneId={PANE} initialView="screen" />);
      await settle();
      expect(view.getByPlaceholderText("Send text to terminal…").props).toMatchObject(literal);
    });
  });

  // A model switch and an away-summary reach the reader as role "system": they
  // render under a muted SYSTEM label, neither YOU nor AGENT.
  test("a system message renders under its own SYSTEM label", async () => {
    mocked.sessionLog.mockResolvedValue(
      log([said("a1", "agent", "On it."), said("s1", "system", "Switched to claude-opus-5"), said("a2", "agent", "Continuing.")]),
    );
    const view = render(<Pane paneId={PANE} />);
    await view.findByText(/Switched to claude-opus-5/);
    expect(view.getAllByText("SYSTEM")).toHaveLength(1);
    expect(view.getAllByText("AGENT")).toHaveLength(2);
    expect(view.queryByText("YOU")).toBeNull();
  });
});

describe("loading", () => {
  test("a log_changed during an in-flight load triggers exactly one refresh, however many arrive", async () => {
    const first = deferred<SessionLog>();
    const second = deferred<SessionLog>();
    const third = deferred<SessionLog>();
    mocked.sessionLog
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValue(third.promise);

    render(<Pane paneId={PANE} />);
    expect(mocked.sessionLog).toHaveBeenCalledTimes(1);

    // The terminal repaints three times while the first fetch is still out.
    logChanged();
    logChanged();
    logChanged();
    expect(mocked.sessionLog).toHaveBeenCalledTimes(1);

    first.resolve(log([said("a1", "agent", "one")]));
    await settle();
    // One rerun for the three, not three.
    expect(mocked.sessionLog).toHaveBeenCalledTimes(2);

    second.resolve(log([said("a1", "agent", "one")]));
    await settle();
    // And nothing further: the rerun had already seen the latest state.
    expect(mocked.sessionLog).toHaveBeenCalledTimes(2);
  });

  test("the transcript and the pane detail are requested concurrently", async () => {
    const logRequest = deferred<SessionLog>();
    const detailRequest = deferred<ReturnType<typeof detail>>();
    mocked.sessionLog.mockReturnValue(logRequest.promise);
    mocked.pane.mockReturnValue(detailRequest.promise);

    const view = render(<Pane paneId={PANE} />);

    // Both on the wire before either has answered — in sequence, the detail
    // would wait a full transcript round trip for nothing.
    expect(mocked.sessionLog).toHaveBeenCalledTimes(1);
    expect(mocked.pane).toHaveBeenCalledTimes(1);

    logRequest.resolve(log([said("a1", "agent", "hello")]));
    detailRequest.resolve(detail({ verb: "Baking" }));
    await view.findByText(/hello/);
    expect(view.getByText("Baking")).toBeTruthy();
  });

  test.each(["sessionLog", "pane"] as const)(
    "an UnauthorizedError from %s is reported to the computer rather than being swallowed",
    async (route) => {
      mocked.sessionLog.mockResolvedValue(log([said("a1", "agent", "hello")]));
      mocked[route].mockRejectedValue(new UnauthorizedError());

      render(<Pane paneId={PANE} />);
      await waitFor(() => expect(mockSession.unauthorized).toHaveBeenCalledTimes(1));
    },
  );

  test.each(["sessionLog", "pane"] as const)("a late %s rejection from the previous computer cannot sign out the next", async (route) => {
    const previous = connection.cookie;
    connection.cookie = "computer-a";
    const pending = deferred<never>();
    mocked.sessionLog.mockResolvedValue(log([said("a1", "agent", "hello")]));
    mocked[route].mockReturnValue(pending.promise);
    const view = render(<Pane paneId={PANE} />);
    connection.cookie = "computer-b";
    await act(async () => { pending.reject(new UnauthorizedError()); });
    expect(mockSession.unauthorized).not.toHaveBeenCalled();
    view.unmount(); connection.cookie = previous;
  });

  test("no transcript yet keeps polling rather than latching", async () => {
    // A just-started agent: the server has no file to read, then it does.
    mocked.sessionLog
      .mockRejectedValueOnce(new Error("no transcript"))
      .mockResolvedValue(log([said("a1", "agent", "First words.")]));

    const view = render(<Pane paneId={PANE} />);
    await view.findByText("Nothing to read yet.");
    expect(mockSession.unauthorized).not.toHaveBeenCalled();
    expect(mocked.sessionLog).toHaveBeenCalledTimes(1);

    // Nobody pushes anything: only the reader's own timer can fill this in.
    await act(async () => {
      jest.advanceTimersByTime(3_000);
    });
    await view.findByText(/First words\./);
    expect(view.queryByText("Nothing to read yet.")).toBeNull();
    expect(mocked.sessionLog.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("keeping your place", () => {
  const remembered = "w1:p-remembered";
  const thread = [
    said("m1", "agent", "Message one"),
    said("m2", "you", "Message two"),
    said("m3", "agent", "Message three"),
  ];

  /** Reads down to a paragraph 404pt into `m1`, as a finger would, and leaves. */
  async function readToParagraph(paneId: string) {
    const visit = render(<Pane paneId={paneId} />);
    await visit.findByText(/Message three/);
    const list = visit.UNSAFE_getByType(FlatList);
    const cell = visit.UNSAFE_getAllByType(list.props.CellRendererComponent).find((c) => c.props.item.id === "m1")!;
    act(() => cell.findAllByType(View)[0]!.props.onLayout({ nativeEvent: { layout: { y: 16, height: 1500 } } }));
    act(() => list.props.onScrollBeginDrag());
    const position = { nativeEvent: { contentSize: { height: 3000 }, layoutMeasurement: { height: 600 }, contentOffset: { y: 420 } } };
    fireEvent(list, "scroll", position);
    fireEvent(list, "scrollEndDrag", position);
    visit.unmount();
  }

  // Pane ids are only unique within one computer. The first computer's
  // conversation must never stand in for the second's, even while the second
  // has nothing to read yet — which is exactly when a cache would show.
  test("another computer never shows a cached conversation for the same pane id", async () => {
    const paneId = "w1:p-cache-owner";
    mocked.sessionLog.mockResolvedValue(log(thread));
    const first = render(<Pane paneId={paneId} />);
    await first.findByText(/Message three/);
    first.unmount();
    mockComputer.api = { ...api };
    mocked.sessionLog.mockRejectedValue(new Error("no transcript"));
    const second = render(<Pane paneId={paneId} />);
    await second.findByText("Nothing to read yet.");
    expect(second.queryByText(/Message three/)).toBeNull();
    second.unmount();
    forgetPaneMemory(api, paneId);
  });

  // An SSH computer signs in again after every reconnect, with a new cookie.
  // Memory guarded by that credential was wiped on each recovery from sleep.
  test("an SSH re-login keeps the reading place and the loaded conversation", async () => {
    const paneId = "w1:p-relogin";
    const previousCookie = connection.cookie;
    try {
      connection.cookie = "shahi_session=before-sleep";
      mocked.sessionLog.mockResolvedValue(log(thread));
      await readToParagraph(paneId);
      expect(paneScrollPlace(api, paneId)).toEqual({ id: "m1", offset: 404 });

      connection.cookie = "shahi_session=after-sleep";
      mocked.sessionLog.mockRejectedValue(new Error("still reconnecting"));
      const again = render(<Pane paneId={paneId} />);
      await again.findByText(/Message three/);
      expect(paneScrollPlace(api, paneId)).toEqual({ id: "m1", offset: 404 });
      expect(again.getByText("Latest ↓")).toBeTruthy();
      again.unmount();
    } finally {
      connection.cookie = previousCookie;
      forgetPaneMemory(api, paneId);
    }
  });

  // Switching computers changes the credential on screen, which cleared every
  // computer's memory; each computer now keeps its own.
  test("switching to another computer and back keeps the first computer's place, view and conversation", async () => {
    const paneId = "w1:p-switch-back";
    const computerA = api;
    const computerB = { ...api };
    const previousCookie = connection.cookie;
    try {
      connection.cookie = "shahi_session=a";
      mocked.sessionLog.mockResolvedValue(log(thread));
      await readToParagraph(paneId);

      connection.cookie = "shahi_session=b";
      mockComputer.api = computerB;
      mocked.sessionLog.mockResolvedValue(log([said("b1", "agent", "Computer B's own reply")]));
      const onB = render(<Pane paneId={paneId} />);
      await onB.findByText(/Computer B's own reply/);
      expect(onB.queryByText(/Message three/)).toBeNull();
      fireEvent.press(onB.getByTestId("view-screen"));
      onB.unmount();

      connection.cookie = "shahi_session=a";
      mockComputer.api = computerA;
      mocked.sessionLog.mockRejectedValue(new Error("reconnecting"));
      const backOnA = render(<Pane paneId={paneId} />);
      await backOnA.findByText(/Message three/);
      expect(backOnA.queryByText(/Computer B's own reply/)).toBeNull();
      expect(paneScrollPlace(computerA, paneId)).toEqual({ id: "m1", offset: 404 });
      // B's Screen choice is B's; A was left reading.
      expect(backOnA.queryByTestId("terminal-body")).toBeNull();
      backOnA.unmount();
    } finally {
      connection.cookie = previousCookie;
      forgetPaneMemory(computerA, paneId);
      forgetPaneMemory(computerB, paneId);
    }
  });

  test("back and repeated re-entry preserve the paragraph inside a multi-screen message", async () => {
    const paneId = "w1:p-tall-paragraph";
    forgetPaneMemory(api, paneId);
    mocked.sessionLog.mockResolvedValue(log(thread));
    const scrollToIndex = jest.spyOn(FlatList.prototype, "scrollToIndex").mockImplementation(() => undefined);
    for (const y of [420, 730]) {
      const visit = render(<Pane paneId={paneId} />);
      await visit.findByText(/Message three/);
      const list = visit.UNSAFE_getByType(FlatList);
      const cell = render(createElement(list.props.CellRendererComponent, {
        item: thread[0], cellKey: "m1", index: 0, children: null, style: undefined,
      }));
      act(() => cell.UNSAFE_getByType(View).props.onLayout({ nativeEvent: { layout: { y: 16, height: 1500 } } }));
      act(() => list.props.onScrollBeginDrag());
      const event = { nativeEvent: {
        contentSize: { height: 3000 }, layoutMeasurement: { height: 600 }, contentOffset: { y },
      } };
      act(() => list.props.onScroll(event));
      act(() => list.props.onScrollEndDrag(event));
      // iOS can emit a layout/programmatic scroll while popping the route.
      // It is not the person's position and must not replace the anchor.
      act(() => list.props.onScroll({ nativeEvent: {
        contentSize: { height: 3000 }, layoutMeasurement: { height: 600 }, contentOffset: { y: 0 },
      } }));
      expect(paneScrollPlace(api, paneId)).toEqual({ id: "m1", offset: y - 16 });
      visit.unmount();
      cell.unmount();
      const again = render(<Pane paneId={paneId} />);
      await again.findByText(/Message three/);
      fireEvent(again.UNSAFE_getByType(FlatList), "contentSizeChange");
      expect(scrollToIndex).toHaveBeenLastCalledWith({ index: 0, animated: false, viewPosition: 0, viewOffset: -(y - 16) });
      again.unmount();
    }
    scrollToIndex.mockRestore();
    forgetPaneMemory(api, paneId);
  });

  test("Read and Screen resizing cannot replace the saved paragraph with a layout offset", async () => {
    const paneId = "w1:p-toggle-layout";
    mocked.sessionLog.mockResolvedValue(log(thread));
    const scrollToIndex = jest.spyOn(FlatList.prototype, "scrollToIndex").mockImplementation(() => undefined);
    const visit = render(<Pane paneId={paneId} />);
    await visit.findByText(/Message three/);
    const list = visit.UNSAFE_getByType(FlatList);
    const cell = visit.UNSAFE_getAllByType(list.props.CellRendererComponent).find((c) => c.props.item.id === "m1")!;
    act(() => cell.findAllByType(View)[0]!.props.onLayout({ nativeEvent: { layout: { y: 16, height: 1500 } } }));
    act(() => list.props.onScrollBeginDrag());
    const position = { nativeEvent: { contentSize: { height: 3000 }, layoutMeasurement: { height: 600 }, contentOffset: { y: 420 } } };
    fireEvent(list, "scroll", position);
    fireEvent(list, "scrollEndDrag", position);
    for (const mode of ["screen", "read"]) {
      fireEvent.press(visit.getByTestId(`view-${mode}`));
      expect(scrollToIndex).toHaveBeenLastCalledWith({ index: 0, animated: false, viewPosition: 0, viewOffset: -404 });
      fireEvent(list, "scroll", { nativeEvent: { ...position.nativeEvent, contentOffset: { y: 0 } } });
      expect(paneScrollPlace(api, paneId)).toEqual({ id: "m1", offset: 404 });
    }
    // Landing once is not enough: earlier virtualized cells can measure later.
    fireEvent(list, "scroll", position);
    scrollToIndex.mockClear();
    act(() => cell.findAllByType(View)[0]!.props.onLayout({ nativeEvent: { layout: { y: 346, height: 1500 } } }));
    act(() => jest.advanceTimersByTime(100));
    expect(scrollToIndex).toHaveBeenCalled();
    expect(paneScrollPlace(api, paneId)).toEqual({ id: "m1", offset: 404 });
    fireEvent(list, "scroll", { nativeEvent: { ...position.nativeEvent, contentOffset: { y: 750 } } });
    act(() => list.props.onScrollBeginDrag());
    scrollToIndex.mockClear();
    act(() => cell.findAllByType(View)[0]!.props.onLayout({ nativeEvent: { layout: { y: 676, height: 1500 } } }));
    act(() => jest.advanceTimersByTime(100));
    expect(scrollToIndex).not.toHaveBeenCalled();
    fireEvent(list, "scrollToIndexFailed", { index: 0, averageItemLength: 200 });
    visit.unmount();
    const calls = scrollToIndex.mock.calls.length;
    act(() => jest.advanceTimersByTime(1000));
    expect(scrollToIndex).toHaveBeenCalledTimes(calls);
    scrollToIndex.mockRestore();
    forgetPaneMemory(api, paneId);
  });

  test("earlier messages survive leaving before the next transcript update", async () => {
    const paneId = "w1:p-earlier-cache";
    forgetPaneMemory(api, paneId);
    mocked.sessionLog.mockResolvedValue({ ...log(thread), total: 63, offset: 60 });
    const visit = render(<Pane paneId={paneId} />);
    await visit.findByText(/Message three/);
    mocked.sessionLog.mockResolvedValueOnce({ ...log([said("old", "agent", "Earlier paragraph")]), total: 63, offset: 59 });
    fireEvent.press(visit.getByText("Load earlier messages"));
    await visit.findByText("Earlier paragraph");
    visit.unmount();
    const again = render(<Pane paneId={paneId} />);
    await again.findByText("Earlier paragraph");
    again.unmount();
    forgetPaneMemory(api, paneId);
  });

  test("near the tail remains an exact place rather than becoming the tail", async () => {
    const paneId = "w1:p-near-tail";
    mocked.sessionLog.mockResolvedValue(log(thread));
    const view = render(<Pane paneId={paneId} />);
    await view.findByText(/Message three/);
    const list = view.UNSAFE_getByType(FlatList);
    const cell = render(createElement(list.props.CellRendererComponent, {
      item: thread[2], cellKey: "m3", index: 2, children: null, style: undefined,
    }));
    act(() => cell.UNSAFE_getByType(View).props.onLayout({ nativeEvent: { layout: { y: 1900, height: 500 } } }));
    const event = { nativeEvent: {
      contentSize: { height: 2600 }, layoutMeasurement: { height: 600 }, contentOffset: { y: 1950 },
    } };
    act(() => list.props.onScrollBeginDrag());
    act(() => list.props.onScroll(event));
    act(() => list.props.onScrollEndDrag(event));
    expect(paneScrollPlace(api, paneId)).toEqual({ id: "m3", offset: 50 });
    view.unmount();
    cell.unmount();
    forgetPaneMemory(api, paneId);
  });

  test("returning to the tail retries until the virtualized list actually reaches it", async () => {
    const paneId = "w1:p-tail-race";
    forgetPaneMemory(api, paneId);
    mocked.sessionLog.mockResolvedValue(log(thread));
    const scrollToEnd = jest.spyOn(FlatList.prototype, "scrollToEnd").mockImplementation(() => undefined);

    const first = render(<Pane paneId={paneId} />);
    await first.findByText(/Message three/);
    const firstList = first.UNSAFE_getByType(FlatList);
    const atBottom = { nativeEvent: {
      contentSize: { height: 2600 }, layoutMeasurement: { height: 600 }, contentOffset: { y: 2000 },
    } };
    act(() => firstList.props.onScrollBeginDrag());
    act(() => firstList.props.onScroll(atBottom));
    act(() => firstList.props.onScrollEndDrag(atBottom));
    expect(paneScrollPlace(api, paneId)).toBe("bottom");
    first.unmount();

    scrollToEnd.mockClear();
    const again = render(<Pane paneId={paneId} />);
    await again.findByText(/Message three/);
    fireEvent(again.UNSAFE_getByType(FlatList), "contentSizeChange");
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
    // The first native call can be clamped while FlatList is still measuring.
    act(() => jest.advanceTimersByTime(100));
    expect(scrollToEnd).toHaveBeenCalledTimes(2);
    // An estimated bottom without the last message measured is not the tail.
    fireEvent(again.UNSAFE_getByType(FlatList), "scroll", atBottom);
    act(() => jest.advanceTimersByTime(5_000));
    expect(scrollToEnd.mock.calls.length).toBeGreaterThan(2);
    const calls = scrollToEnd.mock.calls.length;
    const list = again.UNSAFE_getByType(FlatList);
    const cell = again.UNSAFE_getAllByType(list.props.CellRendererComponent).find((c) => c.props.item.id === "m3")!;
    act(() => cell.findAllByType(View)[0]!.props.onLayout({ nativeEvent: { layout: { y: 2100, height: 500 } } }));
    // Once native reports the measured tail, retries stop.
    fireEvent(list, "scroll", atBottom);
    act(() => jest.advanceTimersByTime(500));
    expect(scrollToEnd).toHaveBeenCalledTimes(calls);

    again.unmount();
    scrollToEnd.mockRestore();
    forgetPaneMemory(api, paneId);
  });

  /** Scrolls away from the tail with `m1` at the top, then leaves the pane. */
  async function leaveScrolledAway() {
    mocked.sessionLog.mockResolvedValue(log(thread));
    const view = render(<Pane paneId={remembered} />);
    await view.findByText(/Message three/);
    const list = view.UNSAFE_getByType(FlatList);
    fireEvent(list, "viewableItemsChanged", { viewableItems: [{ item: thread[0] }] });
    act(() => list.props.onScrollBeginDrag());
    fireEvent(list, "scroll", {
      nativeEvent: { contentSize: { height: 2_000 }, layoutMeasurement: { height: 600 }, contentOffset: { y: 0 } },
    });
    expect(view.getByText("Latest ↓")).toBeTruthy();
    view.unmount();
  }

  test("the measured tail includes bottom padding and stops retrying after landing", async () => {
    const paneId = "w1:p-padding";
    forgetPaneMemory(api, paneId);
    mocked.sessionLog.mockResolvedValue(log(thread));
    const scrollToOffset = jest.spyOn(FlatList.prototype, "scrollToOffset").mockImplementation(() => undefined);
    const visit = render(<Pane paneId={paneId} />);
    await visit.findByText(/Message three/);
    const list = visit.UNSAFE_getByType(FlatList);
    const cell = visit.UNSAFE_getAllByType(list.props.CellRendererComponent).find((c) => c.props.item.id === "m3")!;
    act(() => cell.findAllByType(View)[0]!.props.onLayout({ nativeEvent: { layout: { y: 2100, height: 500 } } }));
    fireEvent(list, "scroll", { nativeEvent: {
      contentSize: { height: 2616 }, layoutMeasurement: { height: 600 }, contentOffset: { y: 2000 },
    } });
    fireEvent(list, "contentSizeChange", 400, 2616);
    expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 2016, animated: false });
    fireEvent(list, "scroll", { nativeEvent: {
      contentSize: { height: 2616 }, layoutMeasurement: { height: 600 }, contentOffset: { y: 2016 },
    } });
    const calls = scrollToOffset.mock.calls.length;
    act(() => jest.advanceTimersByTime(500));
    expect(scrollToOffset).toHaveBeenCalledTimes(calls);
    visit.unmount();
    scrollToOffset.mockRestore();
    forgetPaneMemory(api, paneId);
  });

  test("Go to latest keeps seeking through programmatic momentum instead of saving an intermediate offset", async () => {
    const paneId = "w1:p-jump-long";
    forgetPaneMemory(api, paneId);
    mocked.sessionLog.mockResolvedValue(log(thread));
    const scrollToEnd = jest.spyOn(FlatList.prototype, "scrollToEnd").mockImplementation(() => undefined);
    const view = render(<Pane paneId={paneId} />);
    await view.findByText(/Message three/);
    const list = view.UNSAFE_getByType(FlatList);
    const mid = { nativeEvent: { contentSize: { height: 10000 }, layoutMeasurement: { height: 600 }, contentOffset: { y: 2000 } } };
    act(() => list.props.onScrollBeginDrag());
    fireEvent(list, "scroll", mid);
    fireEvent.press(view.getByTestId("go-to-latest"));
    fireEvent(list, "momentumScrollBegin");
    fireEvent(list, "scroll", mid);
    fireEvent(list, "momentumScrollEnd", mid);
    expect(paneScrollPlace(api, paneId)).toBe("bottom");
    const before = scrollToEnd.mock.calls.length;
    act(() => jest.advanceTimersByTime(5000));
    expect(scrollToEnd.mock.calls.length).toBeGreaterThan(before);
    act(() => list.props.onScrollBeginDrag());
    const cancelled = scrollToEnd.mock.calls.length;
    act(() => jest.advanceTimersByTime(500));
    expect(scrollToEnd.mock.calls.length).toBe(cancelled);
    view.unmount(); scrollToEnd.mockRestore(); forgetPaneMemory(api, paneId);
  });

  test("restore never judges the scroll anchor before any message has arrived", async () => {
    const scrollToEnd = jest.spyOn(FlatList.prototype, "scrollToEnd").mockImplementation(() => undefined);
    const scrollToIndex = jest.spyOn(FlatList.prototype, "scrollToIndex").mockImplementation(() => undefined);
    try {
      await leaveScrolledAway();

      // Coming back: the pane detail answers first with a working agent, and
      // the transcript answers with nothing at all before it fills in.
      mocked.pane.mockResolvedValue(detail({ verb: "Baking" }));
      mocked.sessionLog.mockResolvedValueOnce(log([])).mockResolvedValue(log(thread));
      const view = render(<Pane paneId={remembered} />);
      await view.findByText("Baking");

      // The footer changed the content size while the list is still empty.
      // Judging now would call the anchor "fallen out", jump to the tail and
      // drop the pill — the flake this guards.
      fireEvent(view.UNSAFE_getByType(FlatList), "contentSizeChange");
      expect(scrollToEnd).not.toHaveBeenCalled();
      expect(view.getByText("Latest ↓")).toBeTruthy();

      // Now the messages arrive: the anchor is found and scrolled to.
      logChanged(remembered);
      await view.findByText(/Message three/);
      fireEvent(view.UNSAFE_getByType(FlatList), "contentSizeChange");
      expect(scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 0, viewPosition: 0 }));
      expect(scrollToEnd).not.toHaveBeenCalled();
      expect(view.getByText("Latest ↓")).toBeTruthy();
    } finally {
      scrollToEnd.mockRestore();
      scrollToIndex.mockRestore();
    }
  });

  test("an anchor that really fell out of the window goes to the tail, honestly", async () => {
    const scrollToEnd = jest.spyOn(FlatList.prototype, "scrollToEnd").mockImplementation(() => undefined);
    try {
      await leaveScrolledAway();

      // The conversation moved on past the remembered message.
      mocked.sessionLog.mockResolvedValue(log([said("m9", "agent", "Much later")]));
      const view = render(<Pane paneId={remembered} />);
      await view.findByText(/Much later/);
      fireEvent(view.UNSAFE_getByType(FlatList), "contentSizeChange");
      expect(scrollToEnd).toHaveBeenCalled();
      expect(view.queryByText("Latest ↓")).toBeNull();
    } finally {
      scrollToEnd.mockRestore();
    }
  });

  // VoiceOver's three-finger scroll, its focus moves, a hardware keyboard and
  // the status bar all move the list without a drag. Only a drag used to count
  // as the person's scroll, so each of these was undone (pre-release review).
  const at = (y: number, height = 3000) => ({ nativeEvent: { contentSize: { height }, layoutMeasurement: { height: 600 }, contentOffset: { y } } });

  test("a VoiceOver scroll away from a restored paragraph is not snapped back to it", async () => {
    const paneId = "w1:p-voiceover-anchor";
    mocked.sessionLog.mockResolvedValue(log(thread));
    await readToParagraph(paneId);
    const scrollToIndex = jest.spyOn(FlatList.prototype, "scrollToIndex").mockImplementation(() => undefined);
    try {
      const again = render(<Pane paneId={paneId} />);
      await again.findByText(/Message three/);
      const list = again.UNSAFE_getByType(FlatList);
      const cell = again.UNSAFE_getAllByType(list.props.CellRendererComponent).find((c) => c.props.item.id === "m1")!;
      act(() => cell.findAllByType(View)[0]!.props.onLayout({ nativeEvent: { layout: { y: 16, height: 1500 } } }));
      fireEvent(list, "scroll", at(420)); // the restore lands on the paragraph
      scrollToIndex.mockClear();

      // A page down, with no drag before it, then its animation's end.
      fireEvent(list, "scroll", at(1020));
      fireEvent(list, "momentumScrollEnd", at(1020));
      fireEvent(list, "contentSizeChange", 400, 3000);
      act(() => jest.advanceTimersByTime(500));
      expect(scrollToIndex).not.toHaveBeenCalled();
      expect(paneScrollPlace(api, paneId)).toEqual({ id: "m1", offset: 1004 });
      expect(again.getByText("Latest ↓")).toBeTruthy();
      again.unmount();
    } finally {
      scrollToIndex.mockRestore();
      forgetPaneMemory(api, paneId);
    }
  });

  // The rule that lets the person's scroll through must not let layout in: a
  // message above the paragraph measuring taller moves the offset with it.
  test("a layout shift under a restored paragraph is still corrected, not taken for the reader's scroll", async () => {
    const paneId = "w1:p-layout-shift";
    mocked.sessionLog.mockResolvedValue(log(thread));
    await readToParagraph(paneId);
    const scrollToIndex = jest.spyOn(FlatList.prototype, "scrollToIndex").mockImplementation(() => undefined);
    try {
      const again = render(<Pane paneId={paneId} />);
      await again.findByText(/Message three/);
      const list = again.UNSAFE_getByType(FlatList);
      const cell = again.UNSAFE_getAllByType(list.props.CellRendererComponent).find((c) => c.props.item.id === "m1")!;
      act(() => cell.findAllByType(View)[0]!.props.onLayout({ nativeEvent: { layout: { y: 16, height: 1500 } } }));
      fireEvent(list, "scroll", at(420));
      scrollToIndex.mockClear();
      fireEvent(list, "scroll", at(720, 3300));
      expect(scrollToIndex).toHaveBeenCalled();
      expect(paneScrollPlace(api, paneId)).toEqual({ id: "m1", offset: 404 });
      again.unmount();
    } finally {
      scrollToIndex.mockRestore();
      forgetPaneMemory(api, paneId);
    }
  });

  test("a VoiceOver scroll up from the tail stops following new output", async () => {
    const paneId = "w1:p-voiceover-tail";
    let transcript = thread;
    mocked.sessionLog.mockImplementation(async () => log(transcript));
    const scrollToOffset = jest.spyOn(FlatList.prototype, "scrollToOffset").mockImplementation(() => undefined);
    const scrollToEnd = jest.spyOn(FlatList.prototype, "scrollToEnd").mockImplementation(() => undefined);
    try {
      const view = render(<Pane paneId={paneId} />);
      await view.findByText(/Message three/);
      const list = view.UNSAFE_getByType(FlatList);
      const cell = view.UNSAFE_getAllByType(list.props.CellRendererComponent).find((c) => c.props.item.id === "m3")!;
      act(() => cell.findAllByType(View)[0]!.props.onLayout({ nativeEvent: { layout: { y: 2100, height: 500 } } }));
      fireEvent(list, "scroll", at(2000, 2616));
      fireEvent(list, "contentSizeChange", 400, 2616);
      fireEvent(list, "scroll", at(2016, 2616)); // landed on the tail, following it
      expect(view.queryByText("Latest ↓")).toBeNull();

      fireEvent(list, "scroll", at(1416, 2616));
      expect(view.getByText("Latest ↓")).toBeTruthy();
      scrollToOffset.mockClear();
      scrollToEnd.mockClear();
      transcript = [...thread, said("m4", "agent", "Message four")];
      logChanged(paneId);
      await view.findByText(/Message four/);
      fireEvent(list, "contentSizeChange", 400, 3200);
      expect(scrollToOffset).not.toHaveBeenCalled();
      expect(scrollToEnd).not.toHaveBeenCalled();
      expect(view.getByText("1 new ↓")).toBeTruthy();
      view.unmount();
    } finally {
      scrollToOffset.mockRestore();
      scrollToEnd.mockRestore();
      forgetPaneMemory(api, paneId);
    }
  });

  /** Reports a message's measured frame, the way its cell's onLayout does. */
  function layOut(view: ReturnType<typeof render>, id: string, y: number, height: number) {
    const list = view.UNSAFE_getByType(FlatList);
    const cell = view.UNSAFE_getAllByType(list.props.CellRendererComponent).find((c) => c.props.item.id === id)!;
    act(() => cell.findAllByType(View)[0]!.props.onLayout({ nativeEvent: { layout: { y, height } } }));
  }

  // The restore re-asserts the paragraph on every content change and retries
  // 100ms later. Every scroll event in that window used to be ignored, so a
  // VoiceOver scroll that began in it was swallowed and the retry scrolled
  // back to the paragraph — while the agent was writing, which is when it
  // happens (pre-release review, second pass).
  test("a VoiceOver scroll that begins while output arrives under a restored paragraph is not snapped back to it", async () => {
    const paneId = "w1:p-voiceover-output";
    mocked.sessionLog.mockResolvedValue(log(thread));
    await readToParagraph(paneId);
    const scrollToIndex = jest.spyOn(FlatList.prototype, "scrollToIndex").mockImplementation(() => undefined);
    try {
      const again = render(<Pane paneId={paneId} />);
      await again.findByText(/Message three/);
      const list = again.UNSAFE_getByType(FlatList);
      layOut(again, "m1", 16, 1500);
      fireEvent(list, "scroll", at(420)); // the restore lands on the paragraph
      fireEvent(list, "contentSizeChange", 400, 3300); // the agent writes below it
      expect(scrollToIndex).toHaveBeenCalled(); // the paragraph is held
      scrollToIndex.mockClear();

      fireEvent(list, "scroll", at(1020, 3300)); // a page down, inside the retry's window
      act(() => jest.advanceTimersByTime(500));
      expect(scrollToIndex).not.toHaveBeenCalled();
      expect(paneScrollPlace(api, paneId)).toEqual({ id: "m1", offset: 1004 });
      expect(again.getByText("Latest ↓")).toBeTruthy();
      again.unmount();
    } finally {
      scrollToIndex.mockRestore();
      forgetPaneMemory(api, paneId);
    }
  });

  // A jump straight to the top was never taken for the person's, because a
  // settle event after a drag once had that shape. VoiceOver users do not drag.
  test("a single VoiceOver step straight to the top releases a restored paragraph", async () => {
    const paneId = "w1:p-voiceover-top";
    mocked.sessionLog.mockResolvedValue(log(thread));
    await readToParagraph(paneId);
    const scrollToIndex = jest.spyOn(FlatList.prototype, "scrollToIndex").mockImplementation(() => undefined);
    try {
      const again = render(<Pane paneId={paneId} />);
      await again.findByText(/Message three/);
      const list = again.UNSAFE_getByType(FlatList);
      layOut(again, "m1", 16, 1500);
      fireEvent(list, "scroll", at(420));
      scrollToIndex.mockClear();

      fireEvent(list, "scroll", at(0));
      act(() => jest.advanceTimersByTime(500));
      expect(scrollToIndex).not.toHaveBeenCalled();
      expect(paneScrollPlace(api, paneId)).toEqual({ id: "m1", offset: -16 });
      expect(again.getByText("Latest ↓")).toBeTruthy();
      again.unmount();
    } finally {
      scrollToIndex.mockRestore();
      forgetPaneMemory(api, paneId);
    }
  });

  // After a drag, a jump to the top is still not taken for the person's (the
  // settle rule), so the status bar's own report is what counts.
  test("a tap on the status bar releases a held paragraph and is remembered, even after a drag", async () => {
    const paneId = "w1:p-status-bar";
    mocked.sessionLog.mockResolvedValue(log(thread));
    const scrollToIndex = jest.spyOn(FlatList.prototype, "scrollToIndex").mockImplementation(() => undefined);
    try {
      const view = render(<Pane paneId={paneId} />);
      await view.findByText(/Message three/);
      const list = view.UNSAFE_getByType(FlatList);
      layOut(view, "m1", 16, 1500);
      act(() => list.props.onScrollBeginDrag());
      fireEvent(list, "scroll", at(420));
      fireEvent(list, "scrollEndDrag", at(420));
      // Screen and back holds the paragraph again while the viewport changes.
      fireEvent.press(view.getByTestId("view-screen"));
      fireEvent.press(view.getByTestId("view-read"));
      expect(scrollToIndex).toHaveBeenCalled();
      scrollToIndex.mockClear();

      fireEvent(list, "scroll", at(0));
      fireEvent(list, "scrollToTop", at(0));
      act(() => jest.advanceTimersByTime(500));
      expect(scrollToIndex).not.toHaveBeenCalled();
      expect(paneScrollPlace(api, paneId)).toEqual({ id: "m1", offset: -16 });
      expect(view.getByText("Latest ↓")).toBeTruthy();
      view.unmount();
    } finally {
      scrollToIndex.mockRestore();
      forgetPaneMemory(api, paneId);
    }
  });

  /** Reads down to 50pt into the third message, as a finger would, and leaves. */
  async function readIntoThirdMessage(paneId: string) {
    mocked.sessionLog.mockResolvedValue(log(thread));
    const visit = render(<Pane paneId={paneId} />);
    await visit.findByText(/Message three/);
    const list = visit.UNSAFE_getByType(FlatList);
    layOut(visit, "m3", 2100, 500);
    act(() => list.props.onScrollBeginDrag());
    fireEvent(list, "scroll", at(2150));
    fireEvent(list, "scrollEndDrag", at(2150));
    expect(paneScrollPlace(api, paneId)).toEqual({ id: "m3", offset: 50 });
    visit.unmount();
  }

  /** Reopens it: the paragraph is not measured yet, so FlatList jumps by estimate. */
  async function reopenTowardThirdMessage(paneId: string) {
    const view = render(<Pane paneId={paneId} />);
    await view.findByText(/Message three/);
    const list = view.UNSAFE_getByType(FlatList);
    fireEvent(list, "scroll", at(0));
    fireEvent(list, "contentSizeChange", 400, 3000);
    fireEvent(list, "scrollToIndexFailed", { index: 2, averageItemLength: 200, highestMeasuredFrameIndex: 0 });
    fireEvent(list, "scroll", at(400)); // where the estimate put it
    return { view, list };
  }

  // What the restore does to the list is not the person's scroll: taking it
  // for one would end the restore wherever a slow measure had left it.
  test("the restore's own jump toward a paragraph not yet measured does not end it", async () => {
    const paneId = "w1:p-estimate";
    await readIntoThirdMessage(paneId);
    const scrollToIndex = jest.spyOn(FlatList.prototype, "scrollToIndex").mockImplementation(() => undefined);
    const scrollToOffset = jest.spyOn(FlatList.prototype, "scrollToOffset").mockImplementation(() => undefined);
    try {
      const { view, list } = await reopenTowardThirdMessage(paneId);
      expect(paneScrollPlace(api, paneId)).toEqual({ id: "m3", offset: 50 });
      layOut(view, "m3", 2100, 500);
      scrollToIndex.mockClear();
      act(() => jest.advanceTimersByTime(100));
      expect(scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 2, viewOffset: -50 }));
      fireEvent(list, "scroll", at(2150));
      scrollToIndex.mockClear();
      act(() => jest.advanceTimersByTime(500));
      expect(scrollToIndex).not.toHaveBeenCalled(); // landed
      expect(paneScrollPlace(api, paneId)).toEqual({ id: "m3", offset: 50 });
      view.unmount();
    } finally {
      scrollToIndex.mockRestore();
      scrollToOffset.mockRestore();
      forgetPaneMemory(api, paneId);
    }
  });

  // maintainVisibleContentPosition moves the offset by as much as the message
  // it holds moved. While a virtualized list fills in, messages below measure
  // in the same pass, so the content grows by more than that.
  test("messages measuring above and below at once do not end the restore early", async () => {
    const paneId = "w1:p-measure-both";
    await readIntoThirdMessage(paneId);
    const scrollToIndex = jest.spyOn(FlatList.prototype, "scrollToIndex").mockImplementation(() => undefined);
    const scrollToOffset = jest.spyOn(FlatList.prototype, "scrollToOffset").mockImplementation(() => undefined);
    try {
      const { view, list } = await reopenTowardThirdMessage(paneId);
      layOut(view, "m2", 300, 500);
      // The first message measures 200pt taller than estimated, pushing the
      // second down, while 500pt more below measures too; the list holds the
      // second message where it was.
      layOut(view, "m2", 500, 500);
      fireEvent(list, "scroll", at(600, 3700));
      expect(paneScrollPlace(api, paneId)).toEqual({ id: "m3", offset: 50 });
      layOut(view, "m3", 2300, 500);
      scrollToIndex.mockClear();
      act(() => jest.advanceTimersByTime(100));
      expect(scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 2, viewOffset: -50 }));
      view.unmount();
    } finally {
      scrollToIndex.mockRestore();
      scrollToOffset.mockRestore();
      forgetPaneMemory(api, paneId);
    }
  });

  // A fling's offsets can still be arriving after Go to latest is pressed.
  // They belong to the finger that threw it, not to a new decision to stay.
  test("offsets still arriving from a fling after Go to latest is pressed do not cancel the jump", async () => {
    const paneId = "w1:p-fling-latest";
    mocked.sessionLog.mockResolvedValue(log(thread));
    const scrollToEnd = jest.spyOn(FlatList.prototype, "scrollToEnd").mockImplementation(() => undefined);
    try {
      const view = render(<Pane paneId={paneId} />);
      await view.findByText(/Message three/);
      const list = view.UNSAFE_getByType(FlatList);
      act(() => list.props.onScrollBeginDrag());
      fireEvent(list, "scroll", at(2000, 10000));
      fireEvent(list, "scrollEndDrag", at(2000, 10000));
      fireEvent(list, "momentumScrollBegin");
      fireEvent(list, "scroll", at(2300, 10000));
      fireEvent.press(view.getByTestId("go-to-latest"));
      fireEvent(list, "scroll", at(2500, 10000));
      fireEvent(list, "scroll", at(2650, 10000));
      fireEvent(list, "momentumScrollEnd", at(2700, 10000));
      expect(paneScrollPlace(api, paneId)).toBe("bottom");
      const before = scrollToEnd.mock.calls.length;
      act(() => jest.advanceTimersByTime(500));
      expect(scrollToEnd.mock.calls.length).toBeGreaterThan(before);
      view.unmount();
    } finally {
      scrollToEnd.mockRestore();
      forgetPaneMemory(api, paneId);
    }
  });
});

// At the largest accessibility text size a cold-opened conversation showed no
// messages at all. On an iOS 27 simulator the list's offset ran past the end
// of its content by ~2,300pt a frame, forever: iOS's
// maintainVisibleContentPosition held the wrong view, because clipping had
// detached the list's cells from the content view it searches.
describe("the largest text sizes", () => {
  test("a conversation keeps its off-screen messages attached, so it cannot open blank", async () => {
    mocked.sessionLog.mockResolvedValue(log([said("a1", "agent", "Ready.")]));
    const view = render(<Pane paneId={PANE} />);
    await view.findByText(/Ready\./);
    const list = view.UNSAFE_getByType(FlatList);
    expect(list.props.maintainVisibleContentPosition).toBeTruthy();
    expect(list.props.removeClippedSubviews).toBe(false);
  });

  // A four-option question at AX5 was taller than the screen: the reader was
  // squeezed to a sliver, the composer pushed off the bottom, and the last
  // options were out of reach.
  test("a prompt card scrolls inside a bounded height instead of pushing the conversation and composer off screen", async () => {
    const prompt: ParsedPrompt = {
      question: "Which colour do you prefer?",
      answer: "digit",
      options: [
        { index: 1, label: "Red", selected: true, detail: "Warm, high-contrast." },
        { index: 2, label: "Green", selected: false, detail: "Reads as success." },
        { index: 3, label: "Blue", selected: false },
        { index: 4, label: "Type something.", selected: false },
      ],
    } as ParsedPrompt;
    mocked.sessionLog.mockResolvedValue(log([said("a1", "agent", "May I?")]));
    mocked.pane.mockResolvedValue({ frame: { paneId: PANE, ansi: "", text: "", prompt, activity: null, at: 1 }, layout: null });
    const view = render(<Pane paneId={PANE} />);
    const card = await view.findByTestId("prompt-card");
    const area = view.getByTestId("pane-notices");
    const style = StyleSheet.flatten(area.props.style);
    const { height } = Dimensions.get("window");
    expect(within(area).getByTestId("prompt-card")).toBe(card);
    expect(style.maxHeight).toBeGreaterThan(0);
    expect(style.maxHeight).toBeLessThanOrEqual(height / 2);
    expect(style.flexGrow).toBe(0);
    expect(view.getByText("Type something.")).toBeTruthy();
    expect(view.getByPlaceholderText("Reply to this agent…")).toBeTruthy();
  });

  // Offline at AX1 to AX5, the connection banner above the prompt grew taller
  // than the screen: the prompt collapsed to a border, then the composer and
  // Send went below the screen, and at AX5 the banner's own buttons too, with
  // nothing scrollable (pre-release bug hunt).
  test("offline at the largest text size, the banner and the prompt scroll together above a composer that stays", async () => {
    const window = Dimensions.get("window");
    const screenSize = Dimensions.get("screen");
    act(() => Dimensions.set({ window: { ...window, fontScale: 3.12 }, screen: screenSize }));
    const link = mockSession.link;
    mockSession.link = "lost";
    try {
      const prompt: ParsedPrompt = {
        question: "Allow this edit?", answer: "digit",
        options: [{ index: 1, label: "Yes", selected: true }, { index: 2, label: "No", selected: false }],
      } as ParsedPrompt;
      mocked.sessionLog.mockResolvedValue(log([said("a1", "agent", "May I?")]));
      mocked.pane.mockResolvedValue({ frame: { paneId: PANE, ansi: "", text: "", prompt, activity: null, at: 1 }, layout: null });
      const view = render(<Pane paneId={PANE} />);
      await view.findByTestId("prompt-card");
      const area = view.getByTestId("pane-notices");
      // One bounded, scrolling area holds the banner, its buttons and the prompt...
      expect(within(area).getByText("Retry connection")).toBeTruthy();
      expect(within(area).getByText("Switch computer")).toBeTruthy();
      expect(within(area).getByTestId("prompt-card")).toBeTruthy();
      const style = StyleSheet.flatten(area.props.style);
      expect(style.flexGrow).toBe(0);
      expect(style.maxHeight).toBeLessThanOrEqual(Dimensions.get("window").height / 2);
      // ...and the composer is not in it.
      expect(within(area).queryByText("Send")).toBeNull();
      expect(view.getByText("Send")).toBeTruthy();
    } finally {
      mockSession.link = link;
      act(() => Dimensions.set({ window, screen: screenSize }));
    }
  });

  // At AX5 the reply box sat between attach and Send, a few characters wide,
  // and its placeholder was cut (September 2026 review).
  describe("the composer", () => {
    const window = Dimensions.get("window");
    const screenSize = Dimensions.get("screen");
    const AX5 = 3.12;
    // Jest's React Native preset reports a font scale of 2, already an
    // accessibility size here, so the default size is set explicitly.
    const atSize = (fontScale: number) => act(() => Dimensions.set({ window: { ...window, fontScale }, screen: screenSize }));
    afterEach(() => act(() => Dimensions.set({ window, screen: screenSize })));
    const hostParent = (node: { parent: any }) => {
      let parent = node.parent;
      while (parent && typeof parent.type !== "string") parent = parent.parent;
      return parent;
    };

    function expectPlaceholderReadable(view: ReturnType<typeof render>) {
      const input = view.getByPlaceholderText("Reply to this agent…");
      const style = StyleSheet.flatten(input.props.style);
      // A line of its own, with Send on the line under it...
      expect(style.flexBasis).toBe("100%");
      expect(StyleSheet.flatten(hostParent(input).props.style).flexWrap).toBe("wrap");
      expect(hostParent(hostParent(view.getByText("Send")))).not.toBe(hostParent(input));
      // ...and tall enough for the placeholder wrapped once at this size.
      expect(style.maxHeight).toBeGreaterThanOrEqual(2 * style.fontSize * AX5 * 1.2 + 2 * style.paddingVertical);
    }

    test("its placeholder is not cut at the largest text size, at a cold launch", async () => {
      atSize(AX5);
      mocked.sessionLog.mockResolvedValue(log([said("a1", "agent", "Ready.")]));
      const view = render(<Pane paneId={PANE} />);
      await view.findByText(/Ready\./);
      expectPlaceholderReadable(view);
    });

    test("its placeholder is not cut when the size changes while typing, and the input is not replaced", async () => {
      atSize(1);
      mocked.sessionLog.mockResolvedValue(log([said("a1", "agent", "Ready.")]));
      const view = render(<Pane paneId={PANE} />);
      await view.findByText(/Ready\./);
      const before = view.getByPlaceholderText("Reply to this agent…");
      expect(StyleSheet.flatten(before.props.style).flexBasis).toBeUndefined();
      atSize(AX5);
      expectPlaceholderReadable(view);
      // Replacing it would drop focus, and the keyboard, mid-reply.
      expect(view.getByPlaceholderText("Reply to this agent…")).toBe(before);
    });

    test("at the default size the reply box stays between attach and Send", async () => {
      atSize(1);
      mocked.sessionLog.mockResolvedValue(log([said("a1", "agent", "Ready.")]));
      const view = render(<Pane paneId={PANE} />);
      await view.findByText(/Ready\./);
      const input = view.getByPlaceholderText("Reply to this agent…");
      const style = StyleSheet.flatten(input.props.style);
      expect(style.flexBasis).toBeUndefined();
      expect(style.maxHeight).toBe(120);
      expect(hostParent(hostParent(view.getByText("Send")))).toBe(hostParent(input));
    });
  });
});

// The terminal is a place too, and the one the reader's memory never covered:
// herdr's `visible` is a static screenful of rows, taller and wider than the
// phone, so both axes scroll — and both were thrown back to the top-left on
// every return, which on a wide log meant hunting for your column again. Its
// memory is a pixel offset, not a row id: the block lays out identically on
// each remount (unlike the windowed reader), so the offset that failed the
// reader is the honest place here.
describe("keeping your terminal place", () => {
  const P = "w1:p-term";

  /** A pane detail that carries a screenful of text, so the terminal has one. */
  const withScreen = (text: string) => ({
    frame: { paneId: P, ansi: "", text, prompt: null, activity: null, at: 1 },
    layout: null,
  });

  beforeEach(() => {
    forgetPaneMemory(api, P);
    mocked.sessionLog.mockResolvedValue(log([said("a1", "agent", "hi")]));
    mocked.pane.mockResolvedValue(withScreen("top\nmiddle\nbottom\n"));
  });

  test("Screen displays the terminal while its transcript request is still pending", async () => {
    const transcript = deferred<SessionLog>();
    mocked.sessionLog.mockReturnValue(transcript.promise);
    const visit = render(<Pane paneId={P} initialView="screen" />);
    await settle();
    expect(visit.getByTestId("terminal-body").props.children).toBe("top\nmiddle\nbottom\n");
    transcript.resolve(log([]));
    await settle();
  });

  test("Read can switch to Screen before loading finishes and return without losing output", async () => {
    const transcript = deferred<SessionLog>();
    mocked.sessionLog.mockReturnValue(transcript.promise);
    const visit = render(<Pane paneId={P} />);
    await settle();
    fireEvent.press(visit.getByRole("button", { name: "Screen" }));
    expect(visit.getByTestId("terminal-body").props.children).toBe("top\nmiddle\nbottom\n");
    fireEvent.press(visit.getByRole("button", { name: "Read" }));
    expect(visit.getByText("Reading the conversation…")).toBeTruthy();
    transcript.reject(new Error("no transcript"));
    await settle();
    fireEvent.press(visit.getByText("Show the screen instead"));
    expect(visit.getByTestId("terminal-body").props.children).toBe("top\nmiddle\nbottom\n");
  });

  test("leaving the terminal scrolled down and coming back restores both axes", async () => {
    const first = render(<Pane paneId={P} initialView="screen" />);
    await first.findByTestId("terminal-body");
    fireEvent(first.getByTestId("terminal-across"), "scroll", { nativeEvent: { contentOffset: { x: 240, y: 0 } } });
    fireEvent(first.getByTestId("terminal-down"), "scroll", { nativeEvent: { contentOffset: { x: 0, y: 512 } } });
    first.unmount();

    // A fresh mount, as a route pop and reopen would be: the remembered offset
    // is handed to each ScrollView as its initial contentOffset.
    const again = render(<Pane paneId={P} initialView="screen" />);
    await again.findByTestId("terminal-body");
    expect(again.getByTestId("terminal-across").props.contentOffset).toEqual({ x: 240, y: 0 });
    expect(again.getByTestId("terminal-down").props.contentOffset).toEqual({ x: 0, y: 512 });
  });

  test("a terminal never scrolled opens at the top-left, not somewhere guessed", async () => {
    const view = render(<Pane paneId={P} initialView="screen" />);
    await view.findByTestId("terminal-body");
    expect(view.getByTestId("terminal-across").props.contentOffset).toEqual({ x: 0, y: 0 });
    expect(view.getByTestId("terminal-down").props.contentOffset).toEqual({ x: 0, y: 0 });
  });

  test("leaving a pane on the terminal reopens it on the terminal, not the reader", async () => {
    // Not readable, so the reader would show its ghost — the terminal showing
    // instead is the proof the view was remembered. The way onto the screen
    // here is the ghost's own button, the one path the header toggle is not.
    mocked.sessionLog.mockRejectedValue(new Error("no transcript"));
    const first = render(<Pane paneId={P} />);
    fireEvent.press(await first.findByText("Show the screen instead"));
    await first.findByTestId("terminal-body");
    first.unmount();

    // Reopened with the default view: memory, not the prop, must land it on
    // the terminal.
    const again = render(<Pane paneId={P} />);
    await again.findByTestId("terminal-body");
    expect(again.queryByText("Show the screen instead")).toBeNull();
  });
});

test("a cold reader can prepend messages older than its initial sixty without following the tail", async () => {
  const all = Array.from({ length: 140 }, (_, i) => said(`history-${i}`, "agent", `Message ${i}`));
  mocked.sessionLog.mockImplementation(async (_pane, limit, before) => {
    const end = before ?? all.length;
    const offset = Math.max(0, end - limit);
    return { ...log(all.slice(offset, end)), offset: 123456, total: all.length };
  });
  const ui = render(<Pane paneId="history-pagination" />);
  await settle();
  expect(ui.UNSAFE_getByType(FlatList).props.data).toHaveLength(60);
  fireEvent.press(ui.getByText("Load earlier messages"));
  await settle();
  expect(mocked.sessionLog).toHaveBeenCalledWith("history-pagination", 60, 80);
  const list = ui.UNSAFE_getByType(FlatList);
  expect(list.props.data).toHaveLength(120);
  expect(list.props.data[0].id).toBe("history-20");
  expect(list.props.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 1 });
  fireEvent.press(ui.getByText("Load earlier messages"));
  await settle();
  expect(ui.UNSAFE_getByType(FlatList).props.data).toHaveLength(140);
  expect(ui.queryByText("Load earlier messages")).toBeNull();
  ui.unmount();
});

test("retrying a lost prompt response reuses its id; a new successful send gets another", async () => {
  mocked.sessionLog.mockResolvedValue(log([said("retry-agent", "agent", "Ready to retry.")]));
  mocked.send.mockRejectedValueOnce(new Error("response lost")).mockResolvedValue(receipt);
  const view = render(<Pane paneId="prompt-retry" />);
  await settle();
  const composer = view.getByPlaceholderText("Reply to this agent…");
  fireEvent.changeText(composer, "do this once");
  fireEvent.press(view.getByText("Send"));
  await settle();
  const first = mocked.send.mock.calls[0]![2];
  expect(typeof first).toBe("string");
  fireEvent.press(view.getByText("Send"));
  await settle();
  expect(mocked.send.mock.calls[1]![2]).toBe(first);
  fireEvent.changeText(composer, "do this once");
  fireEvent.press(view.getByText("Send"));
  await settle();
  expect(mocked.send.mock.calls[2]![2]).not.toBe(first);
  view.unmount();
});

test("a send finishing after leaving the conversation does not announce success on another screen", async () => {
  const haptics = require("expo-haptics");
  haptics.notificationAsync.mockClear();
  mocked.sessionLog.mockResolvedValue(log([said("a1", "agent", "Ready.")]));
  const request = deferred<PromptReceipt>();
  mocked.send.mockReturnValue(request.promise);
  const view = render(<Pane paneId={PANE} />);
  await view.findByText(/Ready\./);
  fireEvent.changeText(view.getByPlaceholderText("Reply to this agent…"), "hello");
  fireEvent.press(view.getByText("Send"));
  view.unmount();
  await act(async () => request.resolve(receipt));
  expect(haptics.notificationAsync).not.toHaveBeenCalled();
});

test("draft and uncertain send identity survive leaving and returning to a conversation", async () => {
  mocked.sessionLog.mockResolvedValue(log([said("ready", "agent", "Ready.")]));
  mocked.send.mockRejectedValueOnce(new Error("connection interrupted")).mockResolvedValueOnce(receipt);
  let view = render(<Pane paneId={PANE} />);
  await view.findByText(/Ready\./);
  fireEvent.changeText(view.getByPlaceholderText("Reply to this agent…"), "keep my draft");
  fireEvent.press(view.getByText("Send"));
  await view.findByText("connection interrupted");
  const attempt = mocked.send.mock.calls[0]![2];
  view.unmount();
  view = render(<Pane paneId={PANE} />);
  await view.findByText(/Ready\./);
  expect(view.getByPlaceholderText("Reply to this agent…").props.value).toBe("keep my draft");
  fireEvent.press(view.getByText("Send"));
  await settle();
  expect(mocked.send.mock.calls[1]![2]).toBe(attempt);
  view.unmount();
  view = render(<Pane paneId={PANE} />);
  await view.findByText(/Ready\./);
  expect(view.getByPlaceholderText("Reply to this agent…").props.value).toBe("");
});

test("an early missing-pane response recovers when the new agent’s next frame arrives", async () => {
  mocked.sessionLog.mockResolvedValue(log([said("ready", "agent", "Ready.")]));
  mocked.pane.mockRejectedValueOnce(new Error("not mirrored yet")).mockResolvedValue({ ...detail(), frame: { paneId: PANE, text: "New agent is ready", ansi: "", prompt: null, activity: null, at: 1 } });
  const view = render(<Pane paneId={PANE} initialView="screen" />);
  await settle();
  expect(mocked.pane).toHaveBeenCalledTimes(1);
  logChanged();
  await settle();
  expect(mocked.pane).toHaveBeenCalledTimes(2);
  expect(view.getByText("New agent is ready")).toBeTruthy();
});

test("a dropped connection preserves the loaded conversation and unsent draft without replaying it", async () => {
  const id = "offline-draft";
  mocked.sessionLog.mockResolvedValue(log([said("offline-message", "agent", "Keep reading this reply.")]));
  let view = render(<Pane paneId={id} />);
  await settle();
  fireEvent.changeText(view.getByPlaceholderText("Reply to this agent…"), "Keep this unsent");
  mocked.sessionLog.mockRejectedValue(new Error("connection interrupted"));
  mocked.pane.mockRejectedValue(new Error("connection interrupted"));
  logChanged(id); await settle();
  expect(view.getByText("Keep reading this reply.")).toBeTruthy();
  expect(view.queryByText("Nothing to read yet.")).toBeNull();
  view.unmount();
  view = render(<Pane paneId={id} />); await settle();
  expect(view.getByText("Keep reading this reply.")).toBeTruthy();
  expect(view.getByPlaceholderText("Reply to this agent…").props.value).toBe("Keep this unsent");
  mocked.sessionLog.mockResolvedValue(log([said("offline-message", "agent", "Keep reading this reply.")]));
  logChanged(id); await settle();
  expect(mocked.send).not.toHaveBeenCalled();
  view.unmount();
});

// herdr reuses pane ids: close the highest space, restart herdr, create one,
// and its panes have the old ids. The pre-release bug hunt retried an
// uncertain send across that and it ran in the new shell; the restarted
// sidecar had forgotten the first delivery. The send names its occupant, and
// the server refuses it for any other (409 pane_replaced).
test("a retried send names the conversation it was typed for, so it cannot land in the next one", async () => {
  const pane = mockSession.session.panes[0] as { instanceId?: string };
  pane.instanceId = "term_a";
  try {
    mocked.sessionLog.mockResolvedValue(log([said("a1", "agent", "Shall I roll back?")]));
    mocked.send.mockRejectedValueOnce(new Error("response lost")).mockResolvedValue(receipt);
    const view = render(<Pane paneId={PANE} />);
    await view.findByText(/Shall I roll back\?/);
    fireEvent.changeText(view.getByPlaceholderText("Reply to this agent…"), "yes, roll it back");
    fireEvent.press(view.getByText("Send"));
    await view.findByText("response lost");
    fireEvent.press(view.getByText("Send"));
    await settle();
    expect(mocked.send.mock.calls[0]).toEqual([PANE, "yes, roll it back", expect.any(String), "term_a"]);
    expect(mocked.send.mock.calls[1]).toEqual(mocked.send.mock.calls[0]);
    view.unmount();
  } finally {
    delete pane.instanceId;
  }
});

// Every Claude Code permission offers "1. Yes", so the server can only tell a
// stale card from the request on screen if the tap says which question the
// card showed (pre-release review).
test("answering from the pane says which question the card showed", async () => {
  const bash = {
    question: "Do you want to proceed?",
    answer: "digit" as const,
    options: [{ index: 1, label: "Yes", selected: true }, { index: 2, label: "No", selected: false }],
    context: ["Bash command", "rm -rf build dist\nDelete build and dist directories"],
  };
  const answerPrompt = (api as unknown as { answerPrompt: jest.Mock }).answerPrompt;
  answerPrompt.mockResolvedValue({ ok: true });
  mocked.sessionLog.mockResolvedValue(log([said("a1", "agent", "Cleaning up.")]));
  mocked.pane.mockResolvedValue({ ...detail(), frame: { paneId: PANE, ansi: "", text: "", prompt: bash, activity: null, at: 1 } });
  const view = render(<Pane paneId={PANE} />);
  await view.findByText("Do you want to proceed?");
  fireEvent.press(view.getByText("Yes"));
  await settle();
  expect(answerPrompt).toHaveBeenCalledWith(PANE, bash.options[0], bash, undefined);
  view.unmount();
});

// The pane's card used to render only the question and the options, so an
// approval opened from a notification or a list row read "Do you want to
// proceed?" with nothing to judge it by: the command was only on the Screen
// tab (pre-release bug hunt). The Agents card and the web pane always showed it.
describe("an approval opened in the pane", () => {
  const blockedOn = (prompt: ParsedPrompt) => {
    mocked.sessionLog.mockResolvedValue(log([said("a1", "agent", "Working on it.")]));
    mocked.pane.mockResolvedValue({ ...detail(), frame: { paneId: PANE, ansi: "", text: "", prompt, activity: null, at: 1 } });
    return render(<Pane paneId={PANE} />);
  };

  test("a Claude permission shows the command it would run above its options", async () => {
    const view = blockedOn({
      question: "Do you want to proceed?",
      answer: "digit",
      options: [{ index: 1, label: "Yes", selected: true }, { index: 2, label: "No", selected: false }],
      context: ["Bash command", "rm -rf build dist\nDelete build and dist directories"],
    } as ParsedPrompt);
    const card = await view.findByTestId("prompt-card");
    expect(within(card).getByText(/rm -rf build dist/)).toBeTruthy();
    expect(within(card).getByText("Bash command")).toBeTruthy();
  });

  test("a codex approval shows its reason and command above its options", async () => {
    const view = blockedOn({
      question: "Would you like to run the following command?",
      answer: "digit",
      context: [
        "Reason: May I inspect the failing E2E tests?",
        "$ sed -n '1,180p' e2e/stress.spec.ts",
      ],
      options: [
        { index: 1, label: "Yes, proceed (y)", selected: true },
        { index: 2, label: "No, and tell Codex what to do differently (esc)", selected: false },
      ],
    } as ParsedPrompt);
    const card = await view.findByTestId("prompt-card");
    expect(within(card).getByText("$ sed -n '1,180p' e2e/stress.spec.ts")).toBeTruthy();
    expect(within(card).getByText(/Reason: May I inspect/)).toBeTruthy();
  });
});

// Message ids are only unique within one transcript file: Cursor numbers
// messages from cursor-0, Codex numbers rows. herdr panes persist, so starting
// a new chat in the same pane is ordinary — and the reader used to merge the
// new transcript into the old one by those repeated ids.
describe("a pane reused by a new session", () => {
  const cursor = (sessionId: string, messages: LogMessage[], total = messages.length): SessionLog => ({
    sessionId,
    path: `/home/x/.cursor/projects/p/agent-transcripts/${sessionId}.jsonl`,
    messages,
    total,
    offset: 0,
  });
  const oldChat = [
    said("cursor-0", "you", "OLD secret question"),
    said("cursor-1", "agent", "OLD answer"),
    said("cursor-2", "you", "OLD second question"),
    said("cursor-3", "agent", "OLD second answer"),
  ];

  test("a pane reused by a new Cursor session never shows the previous session's messages", async () => {
    const paneId = "w1:p-reused";
    mocked.sessionLog.mockResolvedValue(cursor("old-chat", oldChat));
    const view = render(<Pane paneId={paneId} />);
    await view.findByText(/OLD second answer/);
    expect(view.queryByText("Load earlier messages")).toBeNull();

    // The new chat's tail window starts at an id the old chat also had.
    mocked.sessionLog.mockResolvedValue(cursor("new-chat", [said("cursor-2", "you", "NEW question"), said("cursor-3", "agent", "NEW answer")], 4));
    logChanged(paneId);
    await view.findByText(/NEW answer/);
    expect(view.queryByText(/OLD/)).toBeNull();
    // Its own history is reachable, rather than the old chat posing as it.
    expect(view.getByText("Load earlier messages")).toBeTruthy();
    view.unmount();

    // Nor does the old chat come back from memory on the next visit.
    mocked.sessionLog.mockRejectedValue(new Error("offline"));
    const again = render(<Pane paneId={paneId} />);
    await again.findByText(/NEW answer/);
    expect(again.queryByText(/OLD/)).toBeNull();
    again.unmount();
    forgetPaneMemory(api, paneId);
  });

  test("a new session opens at its latest message, not at a place in the old one", async () => {
    const paneId = "w1:p-reused-place";
    mocked.sessionLog.mockResolvedValue(cursor("old-chat", oldChat));
    const view = render(<Pane paneId={paneId} />);
    await view.findByText(/OLD second answer/);
    const list = view.UNSAFE_getByType(FlatList);
    act(() => list.props.onScrollBeginDrag());
    fireEvent(list, "scroll", { nativeEvent: { contentSize: { height: 3000 }, layoutMeasurement: { height: 600 }, contentOffset: { y: 100 } } });
    expect(view.getByText("Latest ↓")).toBeTruthy();

    mocked.sessionLog.mockResolvedValue(cursor("new-chat", [said("cursor-0", "you", "NEW question")]));
    logChanged(paneId);
    await view.findByText(/NEW question/);
    expect(view.queryByText("Latest ↓")).toBeNull();
    expect(paneScrollPlace(api, paneId)).toBe("bottom");
    view.unmount();
    forgetPaneMemory(api, paneId);
  });

  test("history requested from the old session is not prepended to the new one", async () => {
    const paneId = "w1:p-reused-history";
    let current = cursor("old-chat", oldChat.slice(2), 4);
    const older = deferred<SessionLog>();
    mocked.sessionLog.mockImplementation(async (_pane: string, _limit: number, before?: number) => (before === undefined ? current : older.promise));
    const view = render(<Pane paneId={paneId} />);
    await view.findByText(/OLD second answer/);
    fireEvent.press(view.getByText("Load earlier messages"));

    current = cursor("new-chat", [said("cursor-0", "you", "NEW question")]);
    logChanged(paneId);
    await view.findByText(/NEW question/);
    older.resolve(cursor("old-chat", oldChat.slice(0, 2), 4));
    await settle();
    expect(view.queryByText(/OLD/)).toBeNull();
    view.unmount();
    forgetPaneMemory(api, paneId);
  });
});

// Claude writes one tool call per record and each result in a later record, so
// a call's result fills in after other messages exist. Only the last message
// was compared by content, so every earlier call kept its cached copy.
test("a tool result that lands after a later message replaces 'Still running.'", async () => {
  const bash = (id: string, summary: string, result: (LogBlock & { kind: "tool" })["result"]): LogMessage => ({
    id, role: "agent", at: 1, blocks: [{ kind: "tool", name: "Bash", summary, result }],
  });
  mocked.sessionLog.mockResolvedValue(log([said("u1", "you", "run both"), bash("t1", "bun test", null), bash("t2", "bun run lint", null)]));
  const view = render(<Pane paneId={PANE} />);
  fireEvent.press(await view.findByText("bun test"));
  expect(view.getByText("Still running.")).toBeTruthy();

  mocked.sessionLog.mockResolvedValue(log([
    said("u1", "you", "run both"),
    bash("t1", "bun test", { text: "12 pass 0 fail", isError: false, truncated: false, images: [] }),
    bash("t2", "bun run lint", { text: "lint failed", isError: true, truncated: false, images: [] }),
    said("a2", "agent", "Both finished."),
  ]));
  logChanged();
  await view.findByText(/Both finished\./);
  expect(view.getByText(/12 pass 0 fail/)).toBeTruthy();
  expect(view.queryByText("Still running.")).toBeNull();
  // The second call's failure is marked, though it was not last either.
  expect(view.getByText("failed")).toBeTruthy();
});

describe("transcript images", () => {
  const withImage: LogMessage = { id: "i1", role: "you", at: 1, blocks: [{ kind: "image", mediaType: "image/png", ref: "uuid-1:0" }] };

  // Over the relay there is no URL an Image could load; the reader used to
  // build one anyway, a host-less path, and every image was an empty box.
  test("an image is shown from what the computer's API fetched, not from a URL built on the screen", async () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    mocked.sessionLog.mockResolvedValue(log([withImage]));
    mocked.transcriptImage.mockResolvedValue({ uri: png });
    const view = render(<Pane paneId={PANE} />);
    const image = await view.findByTestId("transcript-image");
    expect(mocked.transcriptImage).toHaveBeenCalledWith(PANE, "uuid-1:0");
    expect(image.props.source).toEqual({ uri: png });
  });

  test("an image that cannot come through says why in its place", async () => {
    mocked.sessionLog.mockResolvedValue(log([withImage]));
    mocked.transcriptImage.mockRejectedValue(new Error("This image is too large to show through the relay. Connect over SSH, or open it on your computer."));
    const view = render(<Pane paneId={PANE} />);
    expect(await view.findByText(/too large to show through the relay/)).toBeTruthy();
    expect(view.queryByTestId("transcript-image")).toBeNull();
  });
});

// Two banners stayed on screen after a failed send: "Computer disconnected",
// which goes when the link returns, and the send's own error, which did not.
test("a send that failed because the computer was offline stops saying so once the link is live again", async () => {
  const previous = mockSession.link;
  try {
    mocked.sessionLog.mockResolvedValue(log([said("a1", "agent", "Ready.")]));
    mocked.send.mockRejectedValue(new UnreachableError("box", "relay.example", "Your computer is offline — its Shahi service is not connected to the relay."));
    mockSession.link = "lost";
    const view = render(<Pane paneId={PANE} />);
    await view.findByText(/Ready\./);
    fireEvent.changeText(view.getByPlaceholderText("Reply to this agent…"), "hello");
    fireEvent.press(view.getByText("Send"));
    await view.findByText(/Your computer is offline/);

    mockSession.link = "live";
    view.rerender(<Pane paneId={PANE} />);
    expect(view.queryByText(/Your computer is offline/)).toBeNull();
    // The draft was returned to the composer and is still not sent.
    expect(view.getByPlaceholderText("Reply to this agent…").props.value).toBe("hello");
    expect(mocked.send).toHaveBeenCalledTimes(1);
  } finally {
    mockSession.link = previous;
  }
});

test("a refusal from the computer is not cleared by a reconnect", async () => {
  const previous = mockSession.link;
  try {
    mocked.sessionLog.mockResolvedValue(log([said("a1", "agent", "Ready.")]));
    mocked.send.mockRejectedValue(new Error("herdr said no"));
    mockSession.link = "connecting";
    const view = render(<Pane paneId={PANE} />);
    await view.findByText(/Ready\./);
    fireEvent.changeText(view.getByPlaceholderText("Reply to this agent…"), "hello");
    fireEvent.press(view.getByText("Send"));
    await view.findByText("herdr said no");
    mockSession.link = "live";
    view.rerender(<Pane paneId={PANE} />);
    expect(view.getByText("herdr said no")).toBeTruthy();
  } finally {
    mockSession.link = previous;
  }
});

describe("spoken labels", () => {
  test("the jump pill says how many messages arrived while you were away", async () => {
    let transcript = [said("a1", "agent", "First."), said("a2", "agent", "Second.")];
    mocked.sessionLog.mockImplementation(async () => log(transcript));
    const view = render(<Pane paneId={PANE} />);
    await view.findByText(/Second\./);
    const list = view.UNSAFE_getByType(FlatList);
    act(() => list.props.onScrollBeginDrag());
    fireEvent(list, "scroll", { nativeEvent: { contentSize: { height: 3000 }, layoutMeasurement: { height: 600 }, contentOffset: { y: 100 } } });
    expect(view.getByTestId("go-to-latest").props.accessibilityLabel).toBe("Go to latest");

    transcript = [...transcript, said("a3", "agent", "Third."), said("a4", "agent", "Fourth.")];
    logChanged();
    await view.findByText(/Fourth\./);
    expect(view.getByText("2 new ↓")).toBeTruthy();
    expect(view.getByTestId("go-to-latest").props.accessibilityLabel).toBe("2 new messages. Go to latest");
  });

  test("a prompt's options are read as their words, and the row under the cursor is announced as selected", async () => {
    const prompt: ParsedPrompt = {
      question: "Do you want to proceed?",
      answer: "digit",
      options: [
        { index: 1, label: "Yes", selected: true },
        { index: 2, label: "No, and tell Claude what to do differently", selected: false, detail: "Esc" },
      ],
    } as ParsedPrompt;
    mocked.sessionLog.mockResolvedValue(log([said("a1", "agent", "May I?")]));
    mocked.pane.mockResolvedValue({ frame: { paneId: PANE, ansi: "", text: "", prompt, activity: null, at: 1 }, layout: null });
    const view = render(<Pane paneId={PANE} />);
    const yes = await view.findByRole("button", { name: "1. Yes" });
    expect(yes.props.accessibilityState).toMatchObject({ selected: true });
    const no = view.getByRole("button", { name: "2. No, and tell Claude what to do differently. Esc" });
    expect(no.props.accessibilityState).toMatchObject({ selected: false });
  });
});

// herdr stopped while the socket stayed open: the pane's reads answered 503,
// were treated as a blip, and nothing looked wrong until a send failed
// (pre-release bug hunt).
describe("herdr stopped behind a live link", () => {
  const offline = { state: "offline", message: "herdr is offline. Shahi will reconnect automatically." };
  const control = { handshake: { capabilities: ["attachments"], backend: { state: "connected" } as { state: string; message?: string } }, refresh: jest.fn(async () => {}) };
  beforeEach(() => { control.handshake.backend = { state: "connected" }; control.refresh.mockClear(); (mockSession as { control?: object }).control = control; });
  afterEach(() => { delete (mockSession as { control?: object }).control; });

  test("an open pane asks the computer at once and says herdr is not running", async () => {
    mocked.sessionLog.mockResolvedValue(log([said("a1", "agent", "Ready.")]));
    mocked.pane.mockRejectedValue(new ApiError(offline.message, 503, "backend_unavailable"));
    const view = render(<Pane paneId={PANE} />);
    await view.findByText(/Ready\./);
    await waitFor(() => expect(control.refresh).toHaveBeenCalled());
    // The computer's answer, which the header and every banner read.
    control.handshake.backend = offline;
    view.rerender(<Pane paneId={PANE} />);
    expect(view.getByText("herdr isn’t running on your computer")).toBeTruthy();
    expect(view.getByText(offline.message)).toBeTruthy();
  });
});

// A notification or a link for a pane closed since: the screen showed a live
// composer and polled 404s every 2.5 s for as long as it stayed open
// (pre-release bug hunt).
describe("a pane that no longer exists", () => {
  const GONE = "w7:p77";
  const panes = mockSession.session.panes;
  afterEach(() => { mockSession.session.panes = panes; });

  test("a notification for an already closed pane says it is gone, offers no composer, and stops asking", async () => {
    mocked.sessionLog.mockRejectedValue(new ApiError("no such pane", 404));
    mocked.pane.mockRejectedValue(new ApiError("no such pane", 404));
    const view = render(<Pane paneId={GONE} />);
    await view.findByText("This pane is gone");
    expect(view.getByText("Back to agents")).toBeTruthy();
    expect(view.queryByPlaceholderText(/Reply to this/)).toBeNull();
    expect(view.queryByText("Send")).toBeNull();
    const asked = mocked.pane.mock.calls.length;
    await act(async () => { jest.advanceTimersByTime(20_000); });
    await settle();
    expect(mocked.pane.mock.calls.length).toBe(asked);
  });

  test("a pane that answered 404 before the list knew it opens once the list has it", async () => {
    mocked.sessionLog.mockResolvedValue(log([said("a1", "agent", "Started.")]));
    mocked.pane.mockRejectedValueOnce(new ApiError("no such pane", 404));
    mockSession.session.panes = [];
    const view = render(<Pane paneId={GONE} />);
    await view.findByText("This pane is gone");
    mockSession.session.panes = [...panes, { paneId: GONE, title: "New agent", agent: "claude", isAgent: true }];
    view.rerender(<Pane paneId={GONE} />);
    await view.findByText(/Started\./);
    expect(view.queryByText("This pane is gone")).toBeNull();
    expect(view.getByPlaceholderText(/Reply to this/)).toBeTruthy();
  });
});
