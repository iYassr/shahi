import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { FlatList } from "react-native";
import type { LogMessage, PromptReceipt, SessionLog } from "@shahi/shared";
import { api, UnauthorizedError } from "@/lib/api";
import { Pane } from "./pane";

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
    expect(mocked.send).toHaveBeenCalledWith(PANE, "ship it");
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
