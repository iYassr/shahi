import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { FlatList, View } from "react-native";
import { createElement } from "react";
import type { LogBlock, LogMessage, PromptReceipt, SessionLog } from "@shahi/shared";
import { api, connection, UnauthorizedError } from "@/lib/api";
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
  session: {
    panes: [{ paneId: PANE, title: "A task", agent: "claude", isAgent: true }],
  },
  terminalWidth: 100,
  watch: jest.fn(),
  signOut: jest.fn(),
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

jest.mock("@/lib/session", () => ({ useSession: () => mockSession }));

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
  // Fake timers for the whole file, never switched mid-file: a run that
  // faked them in one test and not the next hung outright, as a list timer
  // scheduled under one clock was awaited under the other. RNTL's `waitFor`
  // advances fake timers itself, so the reader's own poll still fires where a
  // test waits for it — and the 4s restore backstop never becomes a real one
  // holding the runner open.
  jest.useFakeTimers();
  mockFrameListeners.clear();
  mockSession.watch.mockReset();
  mockSession.signOut.mockReset();
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
    expect(mocked.send).toHaveBeenCalledWith(PANE, "ship it", expect.any(String));
    // The composer is cleared with the tap, not with the receipt.
    expect(view.getByPlaceholderText("Reply to this agent…").props.value).toBe("");

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
    "an UnauthorizedError from %s signs out rather than being swallowed",
    async (route) => {
      mocked.sessionLog.mockResolvedValue(log([said("a1", "agent", "hello")]));
      mocked[route].mockRejectedValue(new UnauthorizedError());

      render(<Pane paneId={PANE} />);
      await waitFor(() => expect(mockSession.signOut).toHaveBeenCalledTimes(1));
    },
  );

  test("no transcript yet keeps polling rather than latching", async () => {
    // A just-started agent: the server has no file to read, then it does.
    mocked.sessionLog
      .mockRejectedValueOnce(new Error("no transcript"))
      .mockResolvedValue(log([said("a1", "agent", "First words.")]));

    const view = render(<Pane paneId={PANE} />);
    await view.findByText("Nothing to read yet.");
    expect(mockSession.signOut).not.toHaveBeenCalled();
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

  test("a different login cannot reuse a cached transcript with the same pane id", async () => {
    const paneId = "w1:p-cache-owner";
    const previousCookie = connection.cookie;
    try {
      connection.cookie = "first-test-session";
      mocked.sessionLog.mockResolvedValue(log(thread));
      const first = render(<Pane paneId={paneId} />);
      await first.findByText(/Message three/);
      first.unmount();
      connection.cookie = "second-test-session";
      mocked.sessionLog.mockReturnValue(new Promise(() => {}));
      const second = render(<Pane paneId={paneId} />);
      expect(second.queryByText(/Message three/)).toBeNull();
      second.unmount();
    } finally {
      connection.cookie = previousCookie;
      forgetPaneMemory(paneId);
    }
  });

  test("back and repeated re-entry preserve the paragraph inside a multi-screen message", async () => {
    const paneId = "w1:p-tall-paragraph";
    forgetPaneMemory(paneId);
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
      expect(paneScrollPlace(paneId)).toEqual({ id: "m1", offset: y - 16 });
      visit.unmount();
      cell.unmount();
      const again = render(<Pane paneId={paneId} />);
      await again.findByText(/Message three/);
      fireEvent(again.UNSAFE_getByType(FlatList), "contentSizeChange");
      expect(scrollToIndex).toHaveBeenLastCalledWith({ index: 0, animated: false, viewPosition: 0, viewOffset: -(y - 16) });
      again.unmount();
    }
    scrollToIndex.mockRestore();
    forgetPaneMemory(paneId);
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
    expect(paneScrollPlace(paneId)).toEqual({ id: "m3", offset: 50 });
    view.unmount();
    cell.unmount();
    forgetPaneMemory(paneId);
  });

  test("returning to the tail retries until the virtualized list actually reaches it", async () => {
    const paneId = "w1:p-tail-race";
    forgetPaneMemory(paneId);
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
    expect(paneScrollPlace(paneId)).toBe("bottom");
    first.unmount();

    scrollToEnd.mockClear();
    const again = render(<Pane paneId={paneId} />);
    await again.findByText(/Message three/);
    fireEvent(again.UNSAFE_getByType(FlatList), "contentSizeChange");
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
    // The first native call can be clamped while FlatList is still measuring.
    act(() => jest.advanceTimersByTime(100));
    expect(scrollToEnd).toHaveBeenCalledTimes(2);
    // Once native reports the real tail, retries stop.
    fireEvent(again.UNSAFE_getByType(FlatList), "scroll", atBottom);
    act(() => jest.advanceTimersByTime(500));
    expect(scrollToEnd).toHaveBeenCalledTimes(2);

    again.unmount();
    scrollToEnd.mockRestore();
    forgetPaneMemory(paneId);
  });

  /** Scrolls away from the tail with `m1` at the top, then leaves the pane. */
  async function leaveScrolledAway() {
    mocked.sessionLog.mockResolvedValue(log(thread));
    const view = render(<Pane paneId={remembered} />);
    await view.findByText(/Message three/);
    const list = view.UNSAFE_getByType(FlatList);
    fireEvent(list, "viewableItemsChanged", { viewableItems: [{ item: thread[0] }] });
    fireEvent(list, "scrollBeginDrag");
    fireEvent(list, "scroll", {
      nativeEvent: { contentSize: { height: 2_000 }, layoutMeasurement: { height: 600 }, contentOffset: { y: 0 } },
    });
    expect(view.getByText("Latest ↓")).toBeTruthy();
    view.unmount();
  }

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
    forgetPaneMemory(P);
    mocked.sessionLog.mockResolvedValue(log([said("a1", "agent", "hi")]));
    mocked.pane.mockResolvedValue(withScreen("top\nmiddle\nbottom\n"));
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
