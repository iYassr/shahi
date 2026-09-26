import { PDFView, shareFile } from "@/components/pdf-view";
import { nativeDraft, notifyNativeDraft } from "@/lib/drafts";
import type { SetStateAction } from "react";
import { backendUnavailable, supports } from "@shahi/shared";
import { ConnectionHealth } from "@/components/connection-health";
/**
 * A single pane: what the agent said, what it is asking, and a way to reply.
 *
 * Reader-first, like the web client, and for the same reason — the transcript
 * is the readable thing and the terminal is for when you need the real screen.
 * The terminal itself is not here yet; xterm.js has no React Native port and
 * would have to run inside a WebView.
 */
import { memo, useCallback, useEffect, useRef, useState, useMemo } from "react";
import {
  ActivityIndicator,
  BackHandler,
  FlatList,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
} from "react-native";
import { Text, useLargeText } from "@/components/text";
import { Stack } from "expo-router";
import { randomUUID } from "expo-crypto";
// The deep path is deliberate: SDK 57's expo-router vendors react-navigation
// wholesale, so a separately installed @react-navigation/elements would carry
// its own context and read a height of 0. This one shares the router's.
import { useHeaderHeight } from "expo-router/react-navigation";
import { useKeyboardHeight } from "@/lib/keyboard";
import { CopyButton, CopyOnHold } from "@/components/copy";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import type { Activity, LogBlock, LogMessage, ParsedPrompt, PromptOption, SessionLog } from "@shahi/shared";
import { FileDownloadError } from "@shahi/shared/file-download";
import { connection, UnauthorizedError, UnreachableError } from "@/lib/api";
import { coalesce } from "@/lib/coalesce";
import { anchorAt, useScrollCells } from "@/lib/scroll-cells";
import { memoryOf } from "@/lib/reader-memory";
import { committed, refused } from "@/lib/feel";
import { useSession } from "@/lib/session";
import { AGENT_COLORS, theme } from "@/lib/theme";
import { Markdown } from "@/components/markdown";

/** How often to pull while open. The server caches on file size. */
const POLL_MS = 2_500;
/** The fast cadence used right after you act and while the agent is working. */
const POLL_ACTIVE_MS = 700;

/**
 * How many columns to fit across the screen.
 *
 * 146 is what herdr is actually rendering at, so it is the only one that shows
 * a whole line without scrolling — hence "fit". The narrower ones trade the
 * right-hand side for readable text.
 */
const TERMINAL_SIZES = [60, 100, 146];
const WIDEST = 146;
/** Big enough to read a prompt at arm's length, small enough to stay a terminal. */
const MAX_TERMINAL_FONT = 20;
/** Long enough to average out rounding, short enough never to wrap. */
const PROBE_CHARS = 40;
const PROBE_FONT = 12;
/**
 * Starting guess for the monospace advance, replaced by a measurement.
 *
 * Guessing does not work here. Terminal output is full of box drawing, and if
 * the font in use has no glyph for `─` the fallback font's advance is not the
 * one the nominal 0.6em predicts — the estimate comes out narrow, every line
 * wraps, and each box folds in half. So the width is measured once from a probe
 * of the exact character that causes the trouble.
 */
const CHAR_ASPECT_GUESS = 0.6;
const PROBE = "─".repeat(PROBE_CHARS);
/** The most of the window a prompt card may take before it scrolls inside itself. */
const PROMPT_SHARE = 0.4;

/**
 * Keys a touch keyboard cannot produce but agents routinely ask for.
 *
 * The names are herdr's, and it is strict about them: `shift+tab` is accepted
 * and `S-Tab` is not — it answers `invalid_key`, which the key bar swallowed, so
 * the one key Claude Code uses for its permission modes silently did nothing.
 * Every name here has been sent to a live pane and accepted.
 */
// `spoken` is what VoiceOver reads: the glyphs (⇥, ⇧⇥, ^C) are unintelligible
// aloud, so each carries the key's real name.
const KEY_BAR: { label: string; spoken: string; keys: string[] }[] = [
  { label: "Esc", spoken: "Escape", keys: ["Escape"] },
  { label: "Tab", spoken: "Tab", keys: ["Tab"] },
  { label: "Shift+Tab", spoken: "Shift Tab", keys: ["shift+tab"] },
  { label: "↑", spoken: "Up arrow", keys: ["Up"] },
  { label: "↓", spoken: "Down arrow", keys: ["Down"] },
  { label: "Enter", spoken: "Return", keys: ["Enter"] },
  { label: "Ctrl+C", spoken: "Control C", keys: ["C-c"] },
];

export { forgetPaneMemory, paneScrollPlace } from "@/lib/reader-memory";

/**
 * Which transcript a page was read from, as the web reader names it. Message
 * ids are only unique within one file, so this, not the ids, says whether a
 * page continues the conversation on screen.
 */
function transcriptOf(log: Pick<SessionLog, "sessionId" | "path">): string {
  return `${log.sessionId}\n${log.path}`;
}

/**
 * A message's content, computed once per message object. Message objects are
 * never mutated, and a poll answered 304 hands back the very objects compared
 * last time, so an unchanged poll costs no serialisation at all.
 */
const signatures = new WeakMap<LogMessage, string>();
function signature(message: LogMessage): string {
  let text = signatures.get(message);
  if (text === undefined) signatures.set(message, (text = JSON.stringify(message)));
  return text;
}

/**
 * Folds a freshly fetched tail into what is already shown.
 *
 * Two properties carried over from the web reader, both load-bearing there:
 * messages older than the fetched window are kept, so scrolling back through
 * history survives the next poll; and unchanged messages keep their object
 * identity — a quiet poll returns the previous array itself — so the list
 * re-renders nothing when nothing changed.
 *
 * Every fetched message is compared by content, not only the last. This once
 * assumed only the last message could change in place, which is false: a tool
 * call is written before its result, and when an agent runs two calls in
 * parallel the first one's result lands after later messages exist. Keeping
 * the cached copy left that call on "Still running." forever (pre-release
 * review).
 */
function merge(prev: LogMessage[], next: LogMessage[]): LogMessage[] {
  const start = next.length ? prev.findIndex((m) => m.id === next[0]!.id) : -1;
  if (start === -1) return next;
  const head = prev.slice(0, start);
  const prevById = new Map(prev.map((m) => [m.id, m] as const));
  const tail = next.map((m) => {
    const old = prevById.get(m.id);
    return old && (old === m || signature(old) === signature(m)) ? old : m;
  });
  const out = [...head, ...tail];
  const same = out.length === prev.length && out.every((m, i) => m === prev[i]);
  return same ? prev : out;
}

interface Props {
  paneId: string;
  /** A swipe's Screen action lands straight on the terminal. */
  initialView?: "reader" | "screen";
}

export function Pane({ paneId, initialView = "reader" }: Props) {
  const { api, control, watch, onPaneFrame, session, terminalWidth, unauthorized, link } = useSession();
  const savedDraft = useRef(nativeDraft(api, paneId)).current;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const owner = connection.relay ?? connection.cookie;
  const stillActive = useCallback(() => mounted.current && owner === (connection.relay ?? connection.cookie), [owner]);
  const { scroll: scrollMemory, messages: messageMemory, terminalView } = memoryOf(api);
  const [messages, setMessages] = useState<LogMessage[]>(() => messageMemory.get(paneId)?.messages ?? []);
  /** Mirror of `messages`, so merging does not need a functional setState. */
  const messagesRef = useRef<LogMessage[]>(messages);
  /** Which transcript `messages` came from (see `transcriptOf`), once one has loaded. */
  const transcript = useRef<string | null>(messageMemory.get(paneId)?.transcript ?? null);
  const anchorLock = useRef(typeof scrollMemory.get(paneId) === "object");
  const cells = useScrollCells<LogMessage>((message) => message.id, (id, frame, previous) => {
    if (previous && previous.y !== frame.y && !shifted.current.has(id)) shifted.current.set(id, previous.y);
    const spot = scrollMemory.get(paneId);
    if (anchorLock.current && typeof spot === "object" && spot.id === id) {
      pendingRestore.current = true;
      scheduleRestoreRetry();
    }
  });
  /**
   * Optimistic echo: your own reply, shown in the thread the instant you send,
   * before the transcript poll fetches it back. Reconciled away once the real
   * message lands (the transcript's `you` count passes this one's baseline) or
   * after a short timeout, so a dropped send cannot leave a ghost behind.
   */
  const [pending, setPending] = useState<{ message: LogMessage; youBaseline: number; at: number }[]>([]);
  const pendingSeq = useRef(0);
  const promptAttempt = useRef(savedDraft.pending);
  const promptInFlight = useRef(false);
  /**
   * Away from the tail, as state rather than the `following` ref, because the
   * jump pill has to render when it changes. `unseen` counts what arrived
   * while away — the pill's label, same as the web reader's.
   */
  const [away, setAway] = useState(typeof scrollMemory.get(paneId) === "object");
  const [unseen, setUnseen] = useState(0);
  const [prompt, setPrompt] = useState<ParsedPrompt | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  /**
   * Optimistic "working" shown the instant you send, until the agent responds.
   * The real `activity` comes from a poll, which lags the tap by a round trip —
   * and when the activity parse misses entirely, nothing showed at all and the
   * reply appeared out of a silence, which read as the app hanging. This bridges
   * that gap: shown immediately on send, cleared once a new agent message lands
   * or the agent goes idle.
   */
  const [awaiting, setAwaiting] = useState(false);
  const [readable, setReadable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [draft, setDraftState] = useState(savedDraft.text);
  function setDraft(value: SetStateAction<string>) {
    savedDraft.text = typeof value === "function" ? value(savedDraft.text) : value;
    setDraftState(savedDraft.text);
    notifyNativeDraft(savedDraft);
  }
  const [sending, setSending] = useState(savedDraft.inFlight);
  useEffect(() => {
    const update = () => { setDraftState(savedDraft.inFlight ? "" : savedDraft.text); setSending(savedDraft.inFlight); promptAttempt.current = savedDraft.pending; };
    savedDraft.listeners.add(update);
    return () => { savedDraft.listeners.delete(update); };
  }, [savedDraft]);
  const [attaching, setAttaching] = useState(false);
  const [screen, setScreen] = useState<string | null>(null);
  /**
   * Reader or raw screen.
   *
   * The reader is the point of the app, but it only exists for agents that keep
   * a transcript. A plain shell has none, and without the screen there would be
   * nothing to look at while typing into it.
   */
  // A swipe's Screen action (initialView "screen") is an explicit "open the
  // terminal" and wins; a plain tap defers to where you last left this pane.
  const [view, setViewState] = useState<"reader" | "screen">(
    initialView === "screen" ? "screen" : terminalView.get(paneId) ?? "reader",
  );
  const setView = useCallback(
    (v: "reader" | "screen") => {
      if (v === view) return;
      // The Screen key bar changes the reader's viewport even under its overlay.
      // Freeze the anchor before iOS emits its layout-related scroll events.
      userScroll.current = false;
      pendingRestore.current = true;
      anchorLock.current = typeof scrollMemory.get(paneId) === "object";
      terminalView.set(paneId, v);
      setViewState(v);
    },
    [paneId, view],
  );
  /** A file a tool call named, once you have asked to see it. */
  const [viewing, setViewing] = useState<{ path: string; name: string } | null>(null);
  // Opens at the width Settings chose; the buttons on the screen still win.

  const [columns, setColumns] = useState(terminalWidth);
  const [error, setError] = useState<string | null>(null);
  /**
   * Whether the banner reports that the computer could not be reached. Such a
   * banner is cleared when the link is live again: it used to stay under a
   * LIVE connection, beside the recovered conversation, until dismissed by hand.
   */
  const errorUnreachable = useRef(false);
  function showError(e: unknown) {
    errorUnreachable.current = e instanceof UnreachableError;
    setError((e as Error).message);
  }
  useEffect(() => {
    if (link === "live" && errorUnreachable.current) {
      errorUnreachable.current = false;
      setError(null);
    }
  }, [link]);
  const listRef = useRef<FlatList<LogMessage>>(null);
  const olderCursor = useRef<number | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderInFlight = useRef(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  /**
   * Whether to follow new output.
   *
   * The list re-measures on every poll, and snapping to the end each time would
   * drag the reader back down mid-paragraph — the one thing that makes a long
   * transcript unreadable. So it follows only while already at the bottom, and
   * lets go the moment you scroll away. A remembered mid-scroll position means
   * the last visit had already let go.
   */
  const following = useRef(typeof scrollMemory.get(paneId) !== "object");
  /**
   * True while a remembered position is being restored. The restore's own
   * clamped settling and the list measuring around it are ignored until it
   * clears — treating one as the reader's doing is how the position got
   * overwritten — and any other scroll ends it (see `movedByPerson`).
   */
  const pendingRestore = useRef(true);
  const scrollMetrics = useRef({ y: 0, height: 0, viewport: 0 });
  /** A finger drag, or the fling it threw, is moving the list. */
  const userScroll = useRef(false);
  /** What the previous scroll event reported, to tell who moved the list since. */
  const lastScroll = useRef<{ y: number; height: number; viewport: number } | null>(null);
  /** Offsets the reader asked the list for that it has not reported yet; "any" when FlatList picks the offset. */
  const requested = useRef<(number | "any")[]>([]);
  /** Each measured message's y before it moved since the last scroll event. */
  const shifted = useRef(new Map<string, number>());
  /** A fling is decelerating: its offsets belong to the finger that threw it. */
  const momentum = useRef(false);
  /** The person has dragged the list during this visit (see `movedByPerson`). */
  const dragged = useRef(false);
  /** While `Date.now()` is under this, the poll runs at the fast cadence. */
  const activeUntil = useRef(0);
  // Backing refs for the optimistic-working state, so `load` (a stable
  // useCallback) can read and clear it without being torn down every send.
  const awaitingRef = useRef(false);
  const awaitingBaselineAgents = useRef(0);
  const sawActivity = useRef(false);
  const awaitingSince = useRef(0);
  /** Topmost visible message, kept fresh by the list's viewability callback. */
  const topItem = useRef<string | null>(null);
  /** A virtualized list can clamp the first restore before its cells measure. */
  const restoreRetry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const trackTop = useRef(({ viewableItems }: { viewableItems: Array<{ item: LogMessage }> }) => {
    if (viewableItems.length > 0) topItem.current = viewableItems[0]!.item.id;
  }).current;

  /**
   * Puts the remembered message back at the top of the viewport.
   *
   * Called from every content-size change while a restore is pending: the
   * first scrollToIndex usually misses (the anchor is outside the initially
   * rendered window and there is no getItemLayout for variable heights), so
   * onScrollToIndexFailed walks closer by estimate and retries. Nothing
   * reports "the list stopped moving": keep retrying until native layout confirms
   * the target. The person's own scroll cancels the operation immediately.
   */
  function scrollToTail() {
    const last = messagesRef.current.at(-1);
    const { height, viewport } = scrollMetrics.current;
    if (last && cells.frames.current.has(last.id) && viewport > 0) {
      // FlatList.scrollToEnd omits content-container bottom padding. Once the
      // last cell is measured, use the native content extent, including padding.
      const offset = Math.max(0, height - viewport);
      expectScroll(offset);
      listRef.current?.scrollToOffset({ offset, animated: false });
    } else {
      expectScroll("any");
      listRef.current?.scrollToEnd({ animated: false });
    }
  }

  /**
   * Notes where the reader is about to send the list, so the scroll event that
   * reports it is not taken for the person's (see `movedByPerson`). A request
   * the list is already at reports nothing, so a few are kept; a stale number
   * can only match the list landing exactly there again.
   */
  function expectScroll(offset: number | "any") {
    const pending = requested.current;
    if (pending.at(-1) !== offset) pending.push(offset);
    if (pending.length > 4) pending.shift();
  }

  /**
   * Whether the person moved the list, in whatever way: VoiceOver's
   * three-finger scroll and its focus moves, a hardware keyboard, a tap on the
   * status bar. None of those sends onScrollBeginDrag, and treating only a drag
   * as the person's scroll snapped each of them back to a restored paragraph,
   * or kept following the tail and pulled them down on the next message
   * (pre-release review). Instead this names what else moves the list and
   * takes everything left over as the person's:
   *
   * - the reader's own requests (`expectScroll`), however native clamps them;
   * - a resized viewport (keyboard, the Screen key bar, rotation);
   * - maintainVisibleContentPosition holding a message in place while others
   *   measure: the offset moves exactly as far as the content above it grew, or
   *   as a message that moved since the last event (both are needed: while a
   *   virtualized list fills in, cells above and below measure in one pass);
   * - the offset clamped to a content end that shrank under it;
   * - a fling still decelerating, which belongs to the drag that threw it.
   *
   * It runs while a restore is pending too. A restore re-asserts its paragraph
   * on every content change and retries 100ms later, and ignoring every event
   * in that window swallowed a VoiceOver scroll that began in it — the retry
   * then scrolled back to the paragraph (pre-release review, second pass).
   *
   * A native pop/layout settle once emitted one last offset, usually zero,
   * after the person's drag, and saving it was the reproducible
   * lower-paragraph → top jump on reopening. It has not been seen since on
   * React Native 0.86 (whose recycled scroll view resets its offset only after
   * its event emitter is gone), but a jump straight to the top after a drag in
   * this visit is still not the person's. A VoiceOver user never drags, so
   * their jump to the top counts; the status bar reports its own
   * (onScrollToTop).
   */
  function movedByPerson(
    previous: { y: number; height: number; viewport: number } | null,
    now: { y: number; height: number; viewport: number },
  ) {
    const moves = shifted.current;
    shifted.current = new Map();
    const dy = previous ? now.y - previous.y : 0;
    const end = Math.max(0, now.height - now.viewport);
    const asked = requested.current.findIndex((target) =>
      target === "any" ? !previous || Math.abs(dy) > 2 : Math.abs(now.y - Math.min(Math.max(0, target), end)) <= 2,
    );
    if (asked >= 0) {
      requested.current.splice(0, asked + 1);
      return false;
    }
    if (!previous || userScroll.current || momentum.current || Math.abs(dy) <= 2) return false;
    if (Math.abs(now.viewport - previous.viewport) >= 1) return false;
    if (Math.abs(dy - (now.height - previous.height)) <= 2) return false;
    for (const [id, before] of moves) {
      const frame = cells.frames.current.get(id);
      if (frame && Math.abs(dy - (frame.y - before)) <= 2) return false;
    }
    if (now.height < previous.height && Math.abs(now.y - end) <= 2) return false;
    if (now.y <= 0 && dragged.current) return false;
    return true;
  }

  /** The person has moved the list: nothing the reader was doing to it continues. */
  function yieldToPerson() {
    anchorLock.current = false;
    following.current = false;
    requested.current = [];
    finishRestore();
  }

  /** Where the person has put the list becomes the place, the pill and whether to follow. */
  function rememberPlace(e: NativeScrollEvent) {
    if (e.contentOffset.y < 80 && !olderError) void loadOlder();
    const fromBottom = e.contentSize.height - e.layoutMeasurement.height - e.contentOffset.y;
    following.current = fromBottom < 80;
    const anchor = anchorAt(cells.frames.current, e.contentOffset.y);
    // Near the tail is still a distinct reading position. Only the
    // actual tail follows future output after leaving and reopening.
    if (fromBottom <= 2) scrollMemory.set(paneId, "bottom");
    else if (anchor) scrollMemory.set(paneId, anchor);
    else if (topItem.current) scrollMemory.set(paneId, { id: topItem.current, offset: 0 });
    setAway(!following.current);
    if (following.current) setUnseen(0);
  }

  function restoreLanded() {
    const spot = scrollMemory.get(paneId) ?? "bottom";
    const { y, height, viewport } = scrollMetrics.current;
    if (viewport <= 0 || height <= 0) return false;
    if (spot === "bottom") {
      const last = messagesRef.current.at(-1);
      const frame = last && cells.frames.current.get(last.id);
      if (height - viewport - y > 2 || (last && (!frame || frame.y + frame.height > y + viewport + 2))) return false;
      setAway(false);
      setUnseen(0);
    } else {
      const frame = cells.frames.current.get(spot.id);
      if (!frame || height + 2 < frame.y + frame.height || Math.abs(y - Math.max(0, Math.min(frame.y + spot.offset, height - viewport))) >= 2) return false;
    }
    finishRestore();
    return true;
  }

  function restore(checkLanding = true) {
    // Layout can finish without another scroll event (especially at offset 0).
    // Recheck measured cells so an already-landed restore stops retrying.
    if (checkLanding && restoreLanded()) return;
    const spot = scrollMemory.get(paneId) ?? "bottom";
    // Nothing fetched yet means nothing to judge: the anchor cannot have
    // "fallen out" of a window that does not exist. Now that the pane detail is
    // fetched alongside the transcript, the activity footer can render first
    // and change the content size before any message is here; judging then
    // would give up, jump to the tail and drop the pill. Waiting makes the
    // arrival order irrelevant.
    if (typeof spot === "object" && messagesRef.current.length === 0) return;
    if (spot === "bottom") {
      scrollToTail();
      scheduleRestoreRetry();
      return;
    }
    const index =
      typeof spot === "object" ? messagesRef.current.findIndex((m) => m.id === spot.id) : -1;
    if (index < 0) {
      // The anchor fell out of the fetched window: the conversation moved on
      // past your place, and the tail is the closest honest answer.
      anchorLock.current = false;
      following.current = true;
      scrollMemory.set(paneId, "bottom");
      setAway(false);
      scrollToTail();
      scheduleRestoreRetry();
      return;
    }
    // FlatList scrolls to the message's measured offset plus the place in it;
    // one not measured here is its estimate, or a failure handled below.
    const frame = typeof spot === "object" ? cells.frames.current.get(spot.id) : undefined;
    expectScroll(frame && typeof spot === "object" ? frame.y + spot.offset : "any");
    listRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0, viewOffset: typeof spot === "object" ? -spot.offset : 0 });
    scheduleRestoreRetry();
  }

  function finishRestore() {
    pendingRestore.current = false;
    clearTimeout(restoreRetry.current);
  }

  function scheduleRestoreRetry() {
    clearTimeout(restoreRetry.current);
    restoreRetry.current = setTimeout(() => {
      if (pendingRestore.current) restore();
    }, 100);
  }

  useEffect(() => () => {
    clearTimeout(restoreRetry.current);
  }, []);
  const previousView = useRef(view);
  useEffect(() => {
    if (previousView.current === view) return;
    previousView.current = view;
    // Reapply after committing the new viewport. Its previous offset can look
    // correct before native delivers the resize, so don't accept it as landed.
    pendingRestore.current = true;
    restore(false);
  }, [view]);
  // What this pane is, as far as the dashboard knows. A plain shell is not an
  // agent, and asking someone to "reply" to their own bash prompt is nonsense.
  const pane = session?.panes.find((p) => p.paneId === paneId);
  // The native header sits above this screen, and "padding" measures from the
  // window — without the offset the composer stops a header's height short.
  const headerHeight = useHeaderHeight();
  const keyboard = useKeyboardHeight();
  const largeText = useLargeText();

  // Back should close the attachment sheet before it leaves the pane.
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!attaching) return false;
      setAttaching(false);
      return true;
    });
    return () => sub.remove();
  }, [attaching]);

  // Tell the server this pane is being looked at: it drops from the 2s
  // background interval to 400ms, and sorts first, for as long as we are here.
  useEffect(() => {
    watch(paneId);
    return () => watch(null);
  }, [paneId, watch]);

  async function loadOlder() {
    const before = olderCursor.current;
    if (olderInFlight.current || before == null || before <= 0) return;
    olderInFlight.current = true;
    following.current = false;
    setLoadingOlder(true);
    setOlderError(null);
    const from = transcript.current;
    try {
      const page = await api.sessionLog(paneId, 60, before);
      if (!stillActive()) return;
      // History of another transcript — the pane moved to a new session while
      // this page was in flight — belongs to neither conversation.
      if (transcriptOf(page) !== from || from !== transcript.current) return;
      const known = new Set(messagesRef.current.map((m) => m.id));
      const prefix = page.messages.filter((m) => !known.has(m.id));
      const combined = [...prefix, ...messagesRef.current];
      // Prepending history is not a new reply and must not retire optimistic
      // prompts or finish the current agent's working indicator.
      const oldYou = prefix.filter((m) => m.role === "you").length;
      awaitingBaselineAgents.current += prefix.filter((m) => m.role === "agent").length;
      setPending((items) => items.map((item) => ({ ...item, youBaseline: item.youBaseline + oldYou })));
      messagesRef.current = combined;
      messageMemory.set(paneId, { transcript: from, messages: combined });
      olderCursor.current = Math.max(0, Math.min(before, page.total) - page.messages.length);
      setHasOlder(olderCursor.current > 0);
      setMessages(combined);
    } catch (e) {
      if (!stillActive()) return;
      if (e instanceof UnauthorizedError) unauthorized();
      else setOlderError((e as Error).message);
    } finally {
      olderInFlight.current = false;
      setLoadingOlder(false);
    }
  }

  const loadOnce = useCallback(async () => {
    if (!stillActive()) return;
    // Start and apply both responses independently: a slow transcript must
    // never hold terminal output or permission prompts behind Read loading.
    const logRequest = api.sessionLog(paneId, 60);
    const detailRequest = api.pane(paneId);
    const readLog = async () => {
      try {
        const log = await logRequest;
        if (!stillActive()) return;
        // Message ids are only unique within one transcript file: Cursor numbers
        // messages from `cursor-0` and Codex numbers rows, so a herdr pane reused
        // by a new session repeats the old session's ids, and merging by id kept
        // the old conversation's messages in the new one's place (pre-release
        // review). A different transcript starts the reader over: its messages,
        // its history cursor and its place, which is the tail of the new one.
        const source = transcriptOf(log);
        const switched = transcript.current !== null && source !== transcript.current;
        transcript.current = source;
        if (switched) {
          messagesRef.current = [];
          // Counts taken against the old transcript mean nothing in the new one.
          awaitingBaselineAgents.current = 0;
          setPending((items) => items.map((item, i) => ({ ...item, youBaseline: i })));
        }
        const folded = merge(messagesRef.current, log.messages);
        const tailStart = log.messages.length ? folded.findIndex((m) => m.id === log.messages[0]!.id) : 0;
        olderCursor.current = Math.max(0, log.total - log.messages.length - Math.max(0, tailStart));
        setHasOlder(olderCursor.current > 0);
        if (folded !== messagesRef.current) {
          const prevLen = messagesRef.current.length;
          // Not on the first fill: a remount fetching the same conversation is
          // not "60 new" — unseen counts only what arrived while looking away.
          if (!following.current && prevLen > 0)
            setUnseen((u) => u + Math.max(0, folded.length - prevLen));
          messagesRef.current = folded;
          messageMemory.set(paneId, { transcript: source, messages: folded });
          setMessages(folded);
        }
        if (switched) {
          setUnseen(0);
          setAway(false);
          jumpToLatest();
        }
        // The reply has landed once a new agent message exists since we sent — or,
        // as a backstop against a stuck spinner, after ten minutes (an agent can
        // legitimately think for many minutes, so this is generous).
        if (
          awaitingRef.current &&
          (messagesRef.current.filter((m) => m.role === "agent").length > awaitingBaselineAgents.current ||
            Date.now() - awaitingSince.current > 10 * 60_000)
        )
          endAwaiting();
        // Retire an optimistic echo once its real message has landed — the
        // transcript's `you` count has passed the baseline it was stamped with —
        // or after 30s as a backstop, so a send that never persisted can't leave a
        // permanent ghost. Same load that added the real message removes the echo,
        // so they swap without a flicker or a double.
        setPending((prev) => {
          if (prev.length === 0) return prev;
          const you = messagesRef.current.filter((m) => m.role === "you").length;
          const kept = prev.filter((p) => p.youBaseline >= you && Date.now() - p.at < 30_000);
          return kept.length === prev.length ? prev : kept;
        });
        setReadable(true);
        setLoading(false);
      } catch (e) {
        // An expired cookie has to sign out, not be swallowed as "no transcript".
        // The WebSocket only authenticates at handshake, so without this a stale
        // session leaves the pane polling 401 forever while `link` still says
        // LIVE — a dead pane that never recovers. (Found by the data-fetching
        // audit.) The computer makes the call: a poll that raced an SSH
        // re-login is not an expired cookie (pre-release review).
        if (!stillActive()) return;
        if (e instanceof UnauthorizedError) return unauthorized();
        // No transcript *yet*. A just-started agent has not written one, so this
        // keeps polling rather than latching — the reader fills in by itself the
        // moment the agent says something.
        // A failed refresh must not replace a known conversation with an empty
        // state. Keep cached messages (and the mounted list's reading position).
        setReadable(messagesRef.current.length > 0);
        setLoading(false);
      }
    };
    const readScreen = async () => {
      try {
        const detail = await detailRequest;
        if (!stillActive()) return;
        setPrompt(detail.frame?.prompt ?? null);
        const act = detail.frame?.activity ?? null;
        setActivity(act);
        setScreen(detail.frame?.text ?? null);
        if (act) {
          // A working agent means a reply is imminent: keep polling fast so it
          // surfaces the instant it is written, not on the next idle tick.
          sawActivity.current = true;
          activeUntil.current = Math.max(activeUntil.current, Date.now() + 5_000);
        } else if (awaitingRef.current && sawActivity.current) {
          // We saw it working and now it is idle — done, even if we did not catch
          // the reply's message on this exact tick.
          endAwaiting();
        }
      } catch (e) {
        if (!stillActive()) return;
        if (e instanceof UnauthorizedError) return unauthorized();
        // herdr stopped behind a live socket. The computer is asked now rather
        // than on its 30-second poll, and the banner above follows its answer;
        // these 503s were swallowed and the pane looked fine until a send
        // failed (pre-release bug hunt).
        if (backendUnavailable(e) && control?.handshake?.backend.state === "connected") void control.refresh();
        // Otherwise transient; the next poll will catch up.
      }
    };
    await Promise.all([readLog(), readScreen()]);
  }, [paneId, unauthorized, stillActive, control]);
  // One load in flight at most. The timer, a pushed frame and a `log_changed`
  // all call this; while a terminal repaints they arrive faster than a fetch
  // returns, and un-coalesced that was several identical requests outstanding
  // per open reader. Memoised on `loadOnce` so its identity stays stable and
  // the polling effect below is not torn down on every render.
  const load = useMemo(() => coalesce(loadOnce), [loadOnce]);

  /**
   * Adaptive polling. 2.5s is right for reading, but glacial right after you
   * send and while the agent is visibly working — the two moments a reply is
   * imminent. So the loop polls fast (700ms) whenever `activeUntil` is in the
   * future, and `chase`/an active `activity` push that window forward. The old
   * fixed 2.5s interval plus three one-off chase refetches left the reply to
   * land on a 2.5s tick most of the time; this catches it within ~700ms
   * instead, then relaxes back to 2.5s so a quiet pane costs nothing.
   */
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await load();
      if (cancelled) return;
      const fast = Date.now() < activeUntil.current;
      timer = setTimeout(() => void tick(), fast ? POLL_ACTIVE_MS : POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [load]);

  // Event-driven refresh: the server already pushes a frame the instant this
  // pane's content changes, so react to that instead of waiting for the next
  // poll tick — a reply appears as fast as the server sees it. The timer above
  // stays as a backstop for a dropped socket.
  useEffect(() => onPaneFrame(paneId, () => void load()), [paneId, onPaneFrame, load]);

  function chase() {
    // Poll fast for a while: long enough to cover the agent's think time on a
    // quick reply, short enough that a walk-away pane settles back to idle.
    activeUntil.current = Date.now() + 25_000;
    void load();
  }

  // Show "working" now, before any poll can. Baseline the agent-message count so
  // `load` can tell when the reply has actually arrived.
  function beginAwaiting() {
    awaitingBaselineAgents.current = messagesRef.current.filter((m) => m.role === "agent").length;
    sawActivity.current = false;
    awaitingSince.current = Date.now();
    awaitingRef.current = true;
    setAwaiting(true);
  }

  function endAwaiting() {
    if (!awaitingRef.current) return;
    awaitingRef.current = false;
    setAwaiting(false);
  }

  function jumpToLatest() {
    anchorLock.current = false;
    following.current = true;
    scrollMemory.set(paneId, "bottom");
    // scrollToEnd can stop at an estimated bottom on variable-height lists.
    // Keep the target until the last measured message actually reaches view.
    userScroll.current = false;
    pendingRestore.current = true;
    restore();
  }

  async function answer(option: PromptOption) {
    // The card being answered, sent so the server can tell it from a newer one.
    const shown = prompt ?? undefined;
    setPrompt(null);
    beginAwaiting();
    // Chase from the tap, not from the reply to the request: the agent starts
    // moving as soon as herdr has the key, and the fast poll should already be
    // running when it does.
    chase();
    try {
      await api.answerPrompt(paneId, option, shown, pane?.instanceId);
    } catch (e) {
      endAwaiting();
      showError(e);
    }
  }

  async function submit() {
    const text = draft.trim();
    if (!text || promptInFlight.current || savedDraft.inFlight) return;
    promptInFlight.current = true;
    const key = JSON.stringify([paneId, text]);
    // The occupant rides with the operation id, so a retry is refused (409
    // pane_replaced) rather than typed into whatever took the pane id since.
    if (promptAttempt.current?.key !== key) promptAttempt.current = { key, id: randomUUID(), ...(pane?.instanceId ? { instanceId: pane.instanceId } : {}) };
    savedDraft.pending = promptAttempt.current;
    savedDraft.inFlight = true;
    setError(null);
    setSending(true);
    // Echo the message into the thread and show "working", both before the send
    // round-trip — the reader reacts the instant you tap, not after a poll. The
    // baseline is the current `you` count so `load` can retire this echo once the
    // real message lands.
    const id = `pending-${(pendingSeq.current += 1)}`;
    const youNow = messagesRef.current.filter((m) => m.role === "you").length;
    const echo: LogMessage = { id, role: "you", at: Date.now(), blocks: [{ kind: "text", text }] };
    setPending((prev) => [...prev, { message: echo, youBaseline: youNow + prev.length, at: Date.now() }]);
    setDraftState("");
    notifyNativeDraft(savedDraft);
    beginAwaiting();
    // Fast polling starts now, before the request even leaves. It used to start
    // after the send returned — which, when the send was two requests with a
    // 200ms pause between them, meant the first fast tick landed noticeably
    // after the agent had already begun. The send itself is one request now,
    // and the server confirms only that herdr accepted it; the haptic marks
    // that receipt.
    chase();
    try {
      await api.send(paneId, text, promptAttempt.current.id, promptAttempt.current.instanceId);
      if (savedDraft.text === draft) savedDraft.text = "";
      savedDraft.pending = null;
      if (!stillActive()) return;
      promptAttempt.current = null;
      committed();
    } catch (e) {
      if (!stillActive()) return;
      // Delivery may have succeeded before the response was lost. Keep the
      // request id so retry asks for that outcome rather than sending twice.
      setPending((prev) => prev.filter((p) => p.message.id !== id));
      setDraft(text);
      endAwaiting();
      refused();
      showError(e);
    } finally {
      promptInFlight.current = false;
      savedDraft.inFlight = false;
      notifyNativeDraft(savedDraft);
      if (stillActive()) setSending(false);
    }
  }

  const attach = supports(control?.handshake ?? null, "attachments") && (
    <Pressable
      style={styles.attach}
      disabled={sending}
      onPress={() => setAttaching(true)}
      accessibilityRole="button"
      accessibilityLabel="Attach a file"
    >
      <Text style={styles.attachText}>+</Text>
    </Pressable>
  );
  const send = (
    <Pressable
      accessibilityRole="button"
      style={[styles.send, (sending || !draft.trim()) && styles.sendOff]}
      disabled={sending || !draft.trim()}
      onPress={() => void submit()}
    >
      <Text style={styles.sendText}>Send</Text>
    </Pressable>
  );

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      // "padding" on Android too, not just iOS. Under edge-to-edge — the
      // default since SDK 54 — the window no longer resizes when the keyboard
      // opens, so leaving Android on the default meant the composer stayed
      // where it was and the keyboard covered it. Verified on the emulator:
      // taps meant for Send were landing on the keyboard's own Enter key.
      behavior="padding"
      keyboardVerticalOffset={headerHeight}
    >
      {/* The platform's header, not a drawn one: the back chevron, the title,
          and correct insets come with it. Set here because this is where the
          pane is known. */}
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View style={styles.headTitle}>
              <Text style={styles.title} numberOfLines={1}>
                {pane?.title ?? paneId}
              </Text>
              <Text style={styles.subtitle}>{pane?.agent ?? "shell"} · {paneId}</Text>
            </View>
          ),
        }}
      />

      <View style={styles.toggle} accessibilityLabel="Conversation view">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Read"
          accessibilityState={{ selected: view === "reader" }}
          testID="view-read"
          style={[styles.toggleItem, view === "reader" && styles.toggleOn]}
          onPress={() => setView("reader")}
        >
          <Text style={[styles.toggleText, view === "reader" && styles.toggleTextOn]}>Read</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Screen"
          accessibilityState={{ selected: view === "screen" }}
          testID="view-screen"
          style={[styles.toggleItem, view === "screen" && styles.toggleOn]}
          onPress={() => setView("screen")}
        >
          <Text style={[styles.toggleText, view === "screen" && styles.toggleTextOn]}>Screen</Text>
        </Pressable>
      </View>

      <ConnectionHealth />
      {/* Readable and dismissible, instead of one truncated line squeezed
          into the old topbar. */}
      {error && (
        <Pressable accessibilityRole="button" accessibilityLabel={`Dismiss error: ${error}`} style={styles.banner} onPress={() => setError(null)}>
          <Text style={styles.bannerText} numberOfLines={2}>{error}</Text>
          <Text style={styles.bannerClose}>✕</Text>
        </Pressable>
      )}

      {prompt && <Prompt prompt={prompt} onAnswer={answer} />}

      {loading && view === "reader" ? (
        <View style={styles.centered}>
          <ActivityIndicator color={theme.peach} />
          <Text style={styles.dim}>Reading the conversation…</Text>
        </View>
      ) : !readable && view === "reader" ? (
        <View style={styles.centered}>
          <Text style={styles.dim}>
            Nothing to read yet.
          </Text>
          <Text style={styles.dim}>
            A readable conversation is not available yet. You can follow this
            agent in Screen.
          </Text>
          <Pressable accessibilityRole="button" style={styles.ghost} onPress={() => setView("screen")}>
            <Text style={styles.ghostText}>Show the screen instead</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.body}>
        <FlatList
          testID="conversation-list"
          CellRendererComponent={cells.CellRendererComponent}
          contentInsetAdjustmentBehavior="automatic"
          ref={listRef}
          data={pending.length ? [...messages, ...pending.map((p) => p.message)] : messages}
          keyExtractor={(m) => m.id}
          contentContainerStyle={styles.list}
          maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
          ListHeaderComponent={
            hasOlder ? (
              <Pressable accessibilityRole="button" style={styles.ghost} disabled={loadingOlder} onPress={() => void loadOlder()}>
                <Text style={styles.ghostText}>{loadingOlder ? "Loading earlier messages…" : olderError ? `${olderError} — Retry` : "Load earlier messages"}</Text>
              </Pressable>
            ) : null
          }
          // Without this, the first tap anywhere in a scrollable only dismisses
          // the keyboard and is swallowed — so expanding a tool call or
          // pressing a key takes two taps while the composer has focus.
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <Message message={item} paneId={paneId} agentColor={AGENT_COLORS[pane?.agent ?? ""] ?? theme.fg} onOpenFile={setViewing} />
          )}
          // A long transcript is the other list RN can choke on. Rendering a
          // bounded window keeps scrolling and each poll cheap; Message is
          // already memoised and merge() keeps unchanged messages' identity, so
          // a poll re-renders only the tail.
          //
          // Off-screen cells are deliberately NOT detached (removeClippedSubviews).
          // iOS's maintainVisibleContentPosition picks the message it holds in
          // place from the content view's attached subviews, and with clipping
          // those are not the list's cells: it tracked the wrong view and walked
          // the offset past the end of the content, ~2,300pt per frame, forever.
          // At the largest accessibility text size, where one message is taller
          // than the screen, every cold-opened conversation came up blank: on an
          // iOS 27 simulator, blank on every cold launch with clipping and
          // readable on every one without.
          removeClippedSubviews={false}
          initialNumToRender={12}
          maxToRenderPerBatch={10}
          windowSize={9}
          // A drag ends following immediately, before any scroll event is
          // handled. onScroll is throttled to 200ms and its first event of a
          // swipe is usually still within 80px of the bottom, so `following`
          // stayed true into the swipe — and a FlatList's content size changes
          // as it measures cells on the way up, which fired onContentSizeChange
          // and scrolled straight back to the end. Three swipes, three snaps,
          // and the reader never left the tail: the page fighting your finger.
          // Reproduced in the keep-your-place flow; the position is re-derived
          // from the first handled scroll event, so a drag back to the bottom
          // still re-enables following.
          onScrollBeginDrag={() => {
            yieldToPerson();
            dragged.current = true;
            momentum.current = false;
            userScroll.current = true;
          }}
          onScroll={({ nativeEvent: e }) => {
            const now = { y: e.contentOffset.y, height: e.contentSize.height, viewport: e.layoutMeasurement.height };
            // Judged before anything else, the pending restore included: a
            // scroll the reader and layout did not cause ends whatever the
            // reader was doing to the list, however the person started it.
            const theirs = movedByPerson(lastScroll.current, now);
            lastScroll.current = now;
            scrollMetrics.current = { ...now };
            if (theirs) yieldToPerson();
            if (pendingRestore.current) {
              restoreLanded();
              return;
            }
            // Cells preceding the anchor can finish measuring after the first
            // landing. Keep the paragraph fixed until the person moves.
            if (anchorLock.current) {
              if (!restoreLanded()) {
                pendingRestore.current = true;
                restore();
              }
              return;
            }
            if (!userScroll.current && !theirs) return;
            rememberPlace(e);
          }}
          // The status bar's scroll to the top, reported when it arrives. Its
          // last step is a jump to the top that `movedByPerson` would not take
          // for the person's after a drag, so the place is taken from here.
          onScrollToTop={({ nativeEvent: e }) => {
            lastScroll.current = { y: e.contentOffset.y, height: e.contentSize.height, viewport: e.layoutMeasurement.height };
            scrollMetrics.current = { ...lastScroll.current };
            yieldToPerson();
            rememberPlace(e);
          }}
          onScrollEndDrag={({ nativeEvent: e }) => {
            if (pendingRestore.current) return;
            const fromBottom = e.contentSize.height - e.layoutMeasurement.height - e.contentOffset.y;
            const anchor = anchorAt(cells.frames.current, e.contentOffset.y);
            if (fromBottom <= 2) scrollMemory.set(paneId, "bottom");
            else if (anchor) scrollMemory.set(paneId, anchor);
            userScroll.current = false;
          }}
          onMomentumScrollBegin={() => {
            momentum.current = true;
            if (!pendingRestore.current && !anchorLock.current) userScroll.current = true;
          }}
          onMomentumScrollEnd={({ nativeEvent: e }) => {
            momentum.current = false;
            if (pendingRestore.current || anchorLock.current) return;
            const fromBottom = e.contentSize.height - e.layoutMeasurement.height - e.contentOffset.y;
            const anchor = anchorAt(cells.frames.current, e.contentOffset.y);
            if (fromBottom <= 2) scrollMemory.set(paneId, "bottom");
            else if (anchor) scrollMemory.set(paneId, anchor);
            userScroll.current = false;
          }}
          scrollEventThrottle={16}
          // Any visible sliver counts: the anchor should be the message at the
          // top of the screen, not the first one half-past it.
          viewabilityConfig={{ itemVisiblePercentThreshold: 1 }}
          onViewableItemsChanged={trackTop}
          onScrollToIndexFailed={({ index, averageItemLength }) => {
            expectScroll(index * averageItemLength);
            listRef.current?.scrollToOffset({
              offset: index * averageItemLength,
              animated: false,
            });
            if (pendingRestore.current) scheduleRestoreRetry();
          }}
          onLayout={({ nativeEvent: e }) => {
            scrollMetrics.current.viewport = e.layout.height;
            if (pendingRestore.current) restore();
          }}
          onContentSizeChange={(_width, height) => {
            if (height !== undefined) scrollMetrics.current.height = height;
            if (anchorLock.current) {
              pendingRestore.current = true;
              restore(false);
              return;
            }
            if (pendingRestore.current) {
              restore();
              return;
            }
            if (following.current) scrollToTail();
          }}
          ListFooterComponent={
            activity ? (
              <Working activity={activity} />
            ) : awaiting ? (
              <Working activity={AWAITING_ACTIVITY} />
            ) : null
          }
        />

        {view === "reader" && away && (
          <View style={styles.jumpWrap} pointerEvents="box-none">
            <Pressable
              accessibilityRole="button"
              // The count is the pill's news: a fixed "Go to latest" hid it from VoiceOver.
              accessibilityLabel={unseen > 0 ? `${unseen} new ${unseen === 1 ? "message" : "messages"}. Go to latest` : "Go to latest"}
              testID="go-to-latest"
              style={styles.jump}
              onPress={jumpToLatest}
            >
              <Text style={styles.jumpText}>{unseen > 0 ? `${unseen} new ↓` : "Latest ↓"}</Text>
            </Pressable>
          </View>
        )}

        {/* Laid over the reader rather than replacing it, so flipping to the
            terminal and back never unmounts the list — which is what used to
            lose the scroll position. */}
        {view === "screen" && (
          <View style={styles.screenOverlay}>
            <Screen paneId={paneId} text={screen} columns={columns} onColumns={setColumns} />
          </View>
        )}
        </View>
      )}

      {viewing && <FileView file={viewing} onClose={() => setViewing(null)} />}

      <View style={styles.compose}>
        {/* Terminal vocabulary: always there on the screen view, but in the
            reader only while the keyboard is up and you are actually
            answering — the rest of the time it was a row of noise. */}
        {(view === "screen" || keyboard > 0) && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.keys}
          keyboardShouldPersistTaps="handled"
        >
          {KEY_BAR.map(({ label, spoken, keys }) => (
            <Pressable
              key={label}
              style={[styles.key, label === "Ctrl+C" && styles.interruptKey]}
              accessibilityRole="button"
              accessibilityLabel={spoken}
              // Reported, not swallowed: this is how an unsupported key name
              // stayed invisible.
              onPress={() => {
                committed();
                api.sendKeys(paneId, keys, pane?.instanceId).then(chase, (e: Error) => {
                  refused();
                  showError(e);
                });
              }}
            >
              <Text style={styles.keyText}>{label}</Text>
            </Pressable>
          ))}
        </ScrollView>
        )}
        {/* At accessibility sizes the reply box takes a line of its own, with
            the buttons on the line under it. Beside them it was left a few
            characters wide and its placeholder was cut (AX5, September 2026
            review). The input keeps its place among its siblings in both
            layouts, so a size change while typing does not remount it. */}
        <View style={[styles.composeRow, largeText && styles.composeRowStacked]}>
          {!largeText && attach}
          <TextInput
            style={[styles.input, largeText && styles.inputStacked]}
            value={draft}
            editable={!sending}
            onChangeText={setDraft}
            placeholder={view === "screen" ? "Send text to terminal…" : pane && !pane.isAgent ? "Run a command…" : "Reply to this agent…"}
            placeholderTextColor={theme.dim}
            multiline
          />
          {largeText ? <View style={styles.composeButtons}>{attach || <View />}{send}</View> : send}
        </View>
      </View>

      {attaching && (
        <FilePicker
          onClose={() => setAttaching(false)}
          onPick={(path) => {
            // Attachments become paths on their own line, the same as the web
            // client — an agent cannot receive a file over a terminal, but it
            // can read one off disk.
            setDraft((d) => (d ? `${path}\n${d}` : `${path}\n`));
            setAttaching(false);
          }}
        />
      )}
    </KeyboardAvoidingView>
  );
}

/**
 * The answer list, rebuilt from the terminal's own — same numbering, same
 * cursor, sized for a thumb.
 */
function Prompt({
  prompt,
  onAnswer,
}: {
  prompt: ParsedPrompt;
  onAnswer: (option: PromptOption) => Promise<void>;
}) {
  const [armed, setArmed] = useState<number | null>(null);
  const { height } = useWindowDimensions();
  return (
    // Bounded, and scrolls inside itself. At the largest accessibility text
    // size a four-option question grew taller than the screen: it squeezed the
    // conversation to a sliver, pushed the composer off the bottom, and left
    // the last options out of reach (found on a simulator at AX5).
    <ScrollView
      testID="prompt-card"
      style={[styles.promptCard, { maxHeight: Math.round(height * PROMPT_SHARE) }]}
      contentContainerStyle={styles.promptBody}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.question}>{prompt.question}</Text>
      {prompt.options.map((option) => {
        const isArmed = armed === option.index;
        const current = isArmed || (armed === null && option.selected);
        return (
          <Pressable
            accessibilityRole="button"
            // One clean sentence rather than the row's parts: the cursor glyph
            // and its blank placeholder were read aloud, and which row the
            // menu's cursor is on was only visible, never spoken.
            accessibilityLabel={[prompt.answer === "digit" ? `${option.index}. ${option.label}` : option.label, option.detail].filter(Boolean).join(". ")}
            accessibilityState={{ selected: current, disabled: armed !== null }}
            key={option.index}
            style={[styles.choice, isArmed && styles.choiceArmed]}
            disabled={armed !== null}
            onPress={() => {
              setArmed(option.index);
              void onAnswer(option).catch(() => setArmed(null));
            }}
          >
            <Text style={styles.cursor}>{current ? "❯" : " "}</Text>
            {/* The digit is what the terminal takes; a cursor menu has none. */}
            {prompt.answer === "digit" && <Text style={styles.choiceIndex}>{option.index}.</Text>}
            <View style={styles.choiceBody}>
              <Text style={styles.choiceLabel}>{option.label}</Text>
              {option.detail && <Text style={styles.choiceDetail}>{option.detail}</Text>}
            </View>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

// memo is what turns merge's identity-keeping into skipped work: with stable
// message objects and stable other props, an unchanged row never re-renders.
const Message = memo(function Message({
  message,
  paneId,
  agentColor,
  onOpenFile,
}: {
  message: LogMessage;
  paneId: string;
  agentColor: string;
  onOpenFile: (file: { path: string; name: string }) => void;
}) {
  const mine = message.role === "you";
  const system = message.role === "system";
  return (
    <View testID={`message-${message.id}`} style={[styles.msg, mine && styles.msgYou, system && styles.msgSystem]}>
      <Text style={[styles.who, { color: agentColor }, mine && styles.whoYou, system && styles.whoSystem]}>
        {mine ? "YOU" : system ? "SYSTEM" : "AGENT"}
      </Text>
      {message.blocks.map((block, i) => (
        <Block key={i} block={block} paneId={paneId} onOpenFile={onOpenFile} />
      ))}
      {message.blocks.some((block) => block.kind === "text") && (
        <CopyButton text={message.blocks.flatMap((block) => block.kind === "text" ? [block.text] : []).join("\n\n")} />
      )}
    </View>
  );
});

export function Block({
  block,
  paneId,
  onOpenFile,
}: {
  block: LogBlock;
  paneId: string;
  onOpenFile: (file: { path: string; name: string }) => void;
}) {
  const [open, setOpen] = useState(false);

  if (block.kind === "text") return <Markdown text={block.text} onOpenFile={onOpenFile} />;

  if (block.kind === "thinking") {
    return (
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((o) => !o)}>
        <Text style={styles.thinkingLabel}>{open ? "▾ Thinking" : "▸ Thinking"}</Text>
        {open && (
          <Text style={styles.thinking} selectable>
            {block.text}
          </Text>
        )}
      </Pressable>
    );
  }

  if (block.kind === "image") return <TranscriptImage paneId={paneId} imageRef={block.ref} />;

  // Tool calls dominate a real transcript; collapsed, they stop drowning it.
  return (
    <View style={styles.tool}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} style={styles.toolHead} onPress={() => setOpen((o) => !o)}>
        <Text style={styles.toolCaret}>{open ? "▾" : "▸"}</Text>
        <Text style={styles.toolName}>{block.name}</Text>
        <Text style={styles.toolSummary} numberOfLines={1}>{block.summary}</Text>
        {block.result?.isError && <Text style={styles.toolErr}>failed</Text>}
      </Pressable>
      {/*
        * A question the agent asked, shown in full and never collapsed.
        *
        * This is the agent talking to you, not a tool call. Collapsed behind a
        * caret it showed as a bare `AskUserQuestion` row with the choices
        * thrown away, so from a phone there was nothing to read and nothing to
        * answer. Answering still happens on the prompt card — the keystroke
        * goes to the terminal — but the question is legible here.
        */}
      {block.questions?.map((question, i) => (
        <View style={styles.asked} key={i}>
          <Text style={styles.askedQ} selectable>{question.text}</Text>
          {question.options.map((option, n) => (
            <View style={styles.askedOption} key={n}>
              {/* The number is what you would press in the terminal. */}
              <Text style={styles.askedLabel} selectable>
                <Text style={styles.askedN}>{n + 1}. </Text>
                {option.label}
              </Text>
              {option.description ? (
                <Text style={styles.askedWhy} selectable>{option.description}</Text>
              ) : null}
            </View>
          ))}
        </View>
      ))}

      {/* The file the call named. Outside the collapsed section deliberately:
          on a phone this is usually the part you wanted, and burying it behind
          a second tap defeats the point. */}
      {block.file && (
        <Pressable accessibilityRole="button" style={styles.toolFile} onPress={() => onOpenFile(block.file!)}>
          <Text style={styles.toolFileName}>{block.file.name}</Text>
          <Text style={styles.toolFileGo}>open</Text>
        </Pressable>
      )}

      {open && block.result && (
        <>
          {block.result.text.trim().length > 0 && (
            <CopyOnHold text={block.result.text}>
              <ScrollView horizontal style={styles.toolOut}>
                <Text style={styles.toolOutText}>
                  {block.result.text}
                  {/* The server caps tool output. Without saying so the cut
                      reads as the command's own last line. */}
                  {block.result.truncated && "\n… truncated"}
                </Text>
              </ScrollView>
            </CopyOnHold>
          )}
          {block.result.images.map((ref) => (
            <TranscriptImage key={ref} paneId={paneId} imageRef={ref} />
          ))}
          {/* A call that returned nothing is a fact, not an absence: an empty
              expanded tool is indistinguishable from one still working. */}
          {block.result.text.trim().length === 0 && block.result.images.length === 0 && (
            <Text style={styles.toolAside}>(no output)</Text>
          )}
        </>
      )}
      {/* No result yet. The web reader has always said this; the native one
          rendered an empty expansion instead. */}
      {open && !block.result && <Text style={styles.toolAside}>{block.outputUnavailable ? "Output is not included in this transcript." : "Still running."}</Text>}
    </View>
  );
}

/**
 * A file an agent touched, read from the server rather than guessed at.
 *
 * Text and images come down one route and are told apart by content-type,
 * because the server is what decides — it serves HTML and SVG as `text/plain`
 * so agent-written markup cannot run anywhere, and reads are scoped to $HOME
 * and /tmp. Downloads use the authenticated transport before handing a local
 * copy to the system share sheet; server cookies never leave this client.
 */
function FileView({
  file,
  onClose,
}: {
  file: { path: string; name: string };
  onClose: () => void;
}) {
  const { api, transport: connection } = useSession();
  const [body, setBody] = useState<{ text: string } | { imageUrl: string } | { pdfBase64: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setBody(null); setError(null); setSaveError(null);
    void api
      .readFile(file.path)
      .then((result) => live && setBody(result))
      // The computer's reason, when it gave one: a folder, a file outside
      // home, one over 25 MB or an out-of-date computer each say so. Only a
      // request that got no answer is described as offline.
      .catch((e: Error) => live && setError(e instanceof FileDownloadError ? e.message : "This file could not be opened. It may have moved, or your computer may be offline."));
    return () => {
      live = false;
    };
  }, [file.path, api]);

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet">
      <View style={styles.fileSheet}>
        <View style={styles.fileBar}>
          <Text style={styles.viewerName} numberOfLines={1}>
            {file.name}
          </Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Save or share file" disabled={saving} onPress={async () => {
            setSaving(true); setSaveError(null);
            try { await shareFile(body && "pdfBase64" in body ? body.pdfBase64 : await api.downloadFile(file.path), file.name); }
            catch (e) { setSaveError(e instanceof Error ? e.message : "The file could not be saved."); }
            finally { setSaving(false); }
          }} hitSlop={12}><Text style={styles.fileClose}>{saving ? "Saving…" : "Save / Share"}</Text></Pressable>
          <Pressable accessibilityRole="button" onPress={onClose} hitSlop={12}>
            <Text style={styles.fileClose}>Done</Text>
          </Pressable>
        </View>
        <Text style={styles.filePath} numberOfLines={1}>
          {file.path}
        </Text>

        {saveError && <Text style={styles.err}>{saveError}</Text>}
        {error ? (
          <Text style={styles.err}>{error}</Text>
        ) : !body ? (
          <ActivityIndicator color={theme.dim} style={styles.fileWait} />
        ) : "pdfBase64" in body ? (
          <PDFView base64={body.pdfBase64} onError={() => setError("This PDF cannot be previewed. Save it to open in another app.")} />
        ) : "imageUrl" in body ? (
          <Image
            source={{
              uri: body.imageUrl,
              headers: connection.cookie ? { cookie: connection.cookie } : undefined,
            }}
            style={styles.fileImage}
            resizeMode="contain"
          />
        ) : (
          <ScrollView style={styles.fileBody}>
            {/* Horizontally too: source lines are not written to wrap, and
                wrapping them turns code into prose that no longer lines up. */}
            <ScrollView horizontal>
              <Text style={styles.fileText} selectable>{body.text}</Text>
            </ScrollView>
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

/**
 * Images come from the server rather than the transcript payload, through the
 * computer's own API so they travel however that computer is reached — see
 * `api.transcriptImage`. A failure says so in the box it would have filled.
 */
function TranscriptImage({ paneId, imageRef }: { paneId: string; imageRef: string }) {
  const { api } = useSession();
  const [source, setSource] = useState<{ uri: string; headers?: Record<string, string> } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSource(null);
    setFailed(null);
    api.transcriptImage(paneId, imageRef).then(
      (loaded) => { if (live) setSource(loaded); },
      (e: Error) => { if (live) setFailed(e instanceof UnauthorizedError ? "This image could not be loaded." : e.message); },
    );
    return () => { live = false; };
  }, [api, paneId, imageRef]);
  if (!source) {
    return (
      <View style={[styles.image, styles.imagePending]}>
        {failed ? <Text style={styles.toolAside}>{failed}</Text> : <ActivityIndicator color={theme.dim} />}
      </View>
    );
  }
  return (
    <Image
      testID="transcript-image"
      accessibilityLabel="Image from the conversation"
      source={source}
      style={styles.image}
      resizeMode="contain"
      onError={() => { setSource(null); setFailed("This image could not be loaded."); }}
    />
  );
}

/**
 * The pane's actual screen, as characters.
 *
 * herdr renders at a fixed width — 146 columns here — and refuses to reflow it,
 * so the only honest options are to scroll or to shrink. This does both: the
 * text scrolls in one direction and the width control picks a font size that
 * fits a chosen number of columns across the phone, so "all of it" is one tap
 * away even when that means small.
 *
 * Colour is dropped. Reproducing ANSI attributes would mean an emulator in a
 * WebView, and the thing worth seeing on a phone is the words.
 */
function Screen({
  paneId,
  text,
  columns,
  onColumns,
}: {
  paneId: string;
  text: string | null;
  columns: number;
  onColumns: (columns: number) => void;
}) {
  const width = useWindowDimensions().width;
  const { terminalPlace } = memoryOf(useSession().api);
  const [aspect, setAspect] = useState(CHAR_ASPECT_GUESS);
  const fontSize = Math.max(6, Math.min(MAX_TERMINAL_FONT, (width - 24) / (columns * aspect)));

  const body = text ?? "Waiting for the pane…";
  // The text has to be given a width, or it wraps to the viewport. Sizing it to
  // the longest line is also what makes the horizontal scroll mean anything.
  const longest = body.split("\n").reduce((most, line) => Math.max(most, line.length), 0);

  // Where this terminal was, read once on mount. `place` is the live copy the
  // scroll handlers keep current; `start` is the frozen value the restore aims
  // at, so a scroll event mid-restore cannot move the target it is chasing.
  const start = useRef(terminalPlace.get(paneId));
  const place = useRef({ x: start.current?.x ?? 0, y: start.current?.y ?? 0 });
  const across = useRef<ScrollView>(null);
  const down = useRef<ScrollView>(null);
  const restored = useRef(false);
  // `contentOffset` sets the initial position when the content is measured on
  // the first pass; this catches the case where the text lays out a frame
  // later (a fresh fetch, a font-size change), where the initial offset would
  // clamp to zero against not-yet-known content bounds.
  const restore = useCallback(() => {
    if (restored.current || !start.current) return;
    restored.current = true;
    across.current?.scrollTo({ x: start.current.x, animated: false });
    down.current?.scrollTo({ y: start.current.y, animated: false });
  }, []);

  return (
    <View style={styles.screenWrap}>
      {/* Off-screen, one line, measured once — see CHAR_ASPECT_GUESS. */}
      <Text
        style={[styles.screenText, styles.probe, { fontSize: PROBE_FONT }]}
        onLayout={(e) => setAspect(e.nativeEvent.layout.width / PROBE_CHARS / PROBE_FONT)}
      >
        {PROBE}
      </Text>
      <CopyOnHold text={body}>
        <ScrollView
          ref={across}
          horizontal
          testID="terminal-across"
          contentOffset={{ x: start.current?.x ?? 0, y: 0 }}
          onScroll={(e) => {
            place.current.x = e.nativeEvent.contentOffset.x;
            terminalPlace.set(paneId, { ...place.current });
          }}
          onContentSizeChange={restore}
          scrollEventThrottle={100}
        >
          <ScrollView
            ref={down}
            testID="terminal-down"
            contentOffset={{ x: 0, y: start.current?.y ?? 0 }}
            onScroll={(e) => {
              place.current.y = e.nativeEvent.contentOffset.y;
              terminalPlace.set(paneId, { ...place.current });
            }}
            onContentSizeChange={restore}
            scrollEventThrottle={100}
          >
            <Text
              testID="terminal-body"
              style={[
                styles.screenText,
                {
                  fontSize,
                  lineHeight: fontSize * 1.25,
                  width: longest * fontSize * aspect + 24,
                },
              ]}
            >
              {body}
            </Text>
          </ScrollView>
        </ScrollView>
      </CopyOnHold>
      <View style={styles.widths}>
        {TERMINAL_SIZES.map((size) => (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: size === columns }}
            key={size}
            testID={`width-${size}`}
            style={[styles.width, size === columns && styles.widthOn]}
            onPress={() => onColumns(size)}
          >
            <Text style={[styles.widthText, size === columns && styles.widthTextOn]}>
              {size === WIDEST ? "fit" : `${size}c`}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** The optimistic "working" shown between tapping send and the first poll. */
const AWAITING_ACTIVITY: Activity = { verb: "Working", elapsed: "", detail: null };

/** Stands in for the message still being written. */
function Working({ activity }: { activity: Activity }) {
  return (
    <View style={styles.working}>
      <Text style={styles.workingSpin}>✳</Text>
      <Text style={styles.workingVerb}>{activity.verb}</Text>
      <Text style={styles.workingMeta} numberOfLines={1}>
        {activity.elapsed}
        {activity.detail ? ` · ${activity.detail}` : ""}
      </Text>
    </View>
  );
}

/**
 * Attaching a file — from the phone, or from the server it is going to.
 *
 * Both ends matter. A photo of a whiteboard is on the phone; the log the agent
 * needs is already on the server, and making that round-trip through the phone
 * would be absurd. Either way what reaches the agent is a path: a terminal
 * cannot receive a file, but an agent can read one off disk.
 */
export function FilePicker({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (path: string) => void;
}) {
  const { api } = useSession();
  const [path, setPath] = useState("~");
  const [entries, setEntries] = useState<
    { name: string; path: string; display: string; isDirectory: boolean }[]
  >([]);
  const [parent, setParent] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const uploadAbort = useRef<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [directoryAttempt, setDirectoryAttempt] = useState(0);
  const owner = useRef(0);
  useEffect(() => {
    owner.current++;
    setUploading(false);
    setError(null);
    setPath("~");
    return () => { owner.current++; uploadAbort.current?.abort(); };
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    setEntries([]);
    setParent(null);
    setDirectoryError(null);
    void api.dirs(path, true).then((d) => {
      if (cancelled) return;
      setEntries(d.entries);
      setParent(d.parent);
    }).catch(() => {
      if (!cancelled) setDirectoryError("Couldn't open this folder. Check your connection and try again.");
    });
    return () => { cancelled = true; };
  }, [api, path, directoryAttempt]);

  async function pickFromPhone(source: "photos" | "files") {
    if (uploading) return;
    const generation = owner.current;
    const active = () => generation === owner.current;
    setUploading(true);
    setUploadProgress(null);
    const controller = new AbortController(); uploadAbort.current = controller;
    setError(null);
    try {
      let file: { uri: string; name: string; type: string; size?: number };
      if (source === "photos") {
        const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!active()) return;
        if (!permission.granted) {
          setError("Photo access was declined. You can allow it in your phone’s Settings.");
          return;
        }
        const result = await ImagePicker.launchImageLibraryAsync({
          quality: 1,
          // Request JPEG rather than the HEIC that agent image readers cannot open.
          preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
        });
        const asset = result.assets?.[0];
        if (result.canceled || !asset || !active()) return;
        file = { uri: asset.uri, name: asset.fileName ?? `photo.${asset.uri.split(".").pop() ?? "jpg"}`, type: asset.mimeType ?? "image/jpeg", size: asset.fileSize };
      } else {
        const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
        const asset = result.assets?.[0];
        if (result.canceled || !asset || !active()) return;
        file = { uri: asset.uri, name: asset.name, type: asset.mimeType ?? "application/octet-stream", size: asset.size };
      }
      const stored = await api.upload(file, { signal: controller.signal, onProgress: (sent, total) => { if (active()) setUploadProgress(total ? Math.floor(sent / total * 100) : 100); } });
      // A cancelled upload is never attached, even one that finished as Cancel
      // was tapped: attaching it put a path in the composer the person had
      // just said no to, ready to be sent (pre-release review).
      if (!active()) return;
      if (controller.signal.aborted) setError("Upload cancelled.");
      else onPick(stored.path);
    } catch (e) {
      if (active()) setError(controller.signal.aborted ? "Upload cancelled." : e instanceof Error ? e.message : "Couldn't attach this file. Please try again.");
    } finally {
      if (active()) setUploading(false);
    }
  }

  return (
    <View style={styles.sheet}>
      <View style={styles.sheetHead}>
        <Text style={styles.sheetTitle}>Attach a file</Text>
        <Pressable accessibilityRole="button" onPress={onClose} hitSlop={12}>
          <Text style={styles.sheetClose}>Done</Text>
        </Pressable>
      </View>

      <View style={styles.fromPhone}>
        <Pressable accessibilityRole="button" style={styles.phoneButton} disabled={uploading} onPress={() => void pickFromPhone("photos")}>
          <Text style={styles.phoneButtonText}>Photo</Text>
        </Pressable>
        <Pressable accessibilityRole="button" style={styles.phoneButton} disabled={uploading} onPress={() => void pickFromPhone("files")}>
          <Text style={styles.phoneButtonText}>File on phone</Text>
        </Pressable>
      </View>
      {uploading && <>
        <Text style={styles.sheetNote}>{uploadProgress === null ? "Uploading…" : `Uploading ${uploadProgress}%`}</Text>
        <Pressable accessibilityRole="button" onPress={() => uploadAbort.current?.abort()}><Text style={styles.phoneButtonText}>Cancel upload</Text></Pressable>
      </>}
      {error && <Text style={styles.uploadErr}>{error}</Text>}

      <Text style={styles.sheetPath} numberOfLines={1}>{path}</Text>
      {directoryError && <View>
        <Text accessibilityRole="alert" style={styles.uploadErr}>{directoryError}</Text>
        <Pressable accessibilityRole="button" style={styles.phoneButton} onPress={() => setDirectoryAttempt(n => n + 1)}>
          <Text style={styles.phoneButtonText}>Try again</Text>
        </Pressable>
      </View>}
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        data={parent ? [{ name: parent, path: parent, display: parent, isDirectory: true }, ...entries] : entries}
        keyExtractor={(e) => e.path}
        style={{ maxHeight: 320 }}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item, index }) => (
          <Pressable
            accessibilityRole="button"
            style={styles.fileRow}
            onPress={() => (item.isDirectory ? setPath(item.display) : onPick(item.path))}
          >
            <Text style={styles.fileGlyph}>
              {parent && index === 0 ? "↰" : item.isDirectory ? "/" : "·"}
            </Text>
            <Text style={styles.fileName} numberOfLines={1}>{item.name}</Text>
          </Pressable>
        )}
      />
      <Text style={styles.sheetNote}>Tap a file on your computer to attach it. Tap a folder to open it.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.void },
  body: { flex: 1 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 10 },
  dim: { color: theme.dim, textAlign: "center" },

  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: theme.surface,
    borderBottomWidth: 1,
    borderBottomColor: theme.rose,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  bannerText: { color: theme.rose, fontSize: 13, flex: 1 },
  bannerClose: { color: theme.dim, fontSize: 13 },

  headTitle: { alignItems: "center", maxWidth: "100%" },
  title: { color: theme.fg, fontSize: 14 },
  subtitle: { color: theme.dim, fontFamily: theme.mono, fontSize: 10, marginTop: 1 },

  jumpWrap: { position: "absolute", left: 0, right: 0, bottom: 14, alignItems: "center" },
  jump: {
    backgroundColor: theme.raised,
    borderWidth: 1,
    borderColor: theme.lineBright,
    borderRadius: 999,
    paddingHorizontal: 14,
    minHeight: 34,
    justifyContent: "center",
  },
  jumpText: { color: theme.peach, fontSize: 12 },

  screenOverlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: theme.void },
  // Keep touch targets in the content layout, independent of native title sizing.
  toggle: { flexDirection: "row", paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: theme.line },
  toggleItem: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", borderBottomWidth: 2, borderBottomColor: "transparent" },
  toggleOn: { borderBottomColor: theme.peach },
  toggleText: { color: theme.dim, fontSize: 12 },
  toggleTextOn: { color: theme.fg, fontWeight: "700" },

  screenWrap: { flex: 1 },
  probe: { position: "absolute", opacity: 0, left: 0, top: 0 },
  screenText: { color: theme.fg, fontFamily: theme.mono, padding: 12 },
  widths: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: theme.line,
  },
  width: {
    minHeight: 34,
    paddingHorizontal: 12,
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.line,
    borderRadius: 7, borderCurve: "continuous",
  },
  widthOn: { borderColor: theme.lineBright, backgroundColor: theme.raised },
  widthText: { color: theme.dim, fontSize: 12 },
  widthTextOn: { color: theme.fg },
  ghost: {
    marginTop: 6,
    minHeight: 44,
    paddingHorizontal: 16,
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.lineBright,
    borderRadius: 8, borderCurve: "continuous",
  },
  ghostText: { color: theme.peach, fontSize: 13 },

  list: { padding: 16 },
  msg: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: theme.line },
  msgYou: {
    backgroundColor: `${theme.working}0D`,
    borderLeftWidth: 2,
    borderLeftColor: theme.working,
    borderBottomWidth: 0,
    borderRadius: 8, borderCurve: "continuous",
    paddingHorizontal: 12,
    marginVertical: 8,
  },
  who: { fontSize: 10, fontWeight: "600", letterSpacing: 0.8, marginBottom: 6 },
  whoYou: { color: theme.working },
  // A system note (a model switch, an away-summary): quiet chrome, not the
  // agent speaking — dim, set off by a rule, never the loud "you" fill.
  msgSystem: { borderLeftWidth: 2, borderLeftColor: theme.lineBright, paddingHorizontal: 12, opacity: 0.85 },
  whoSystem: { color: theme.dim },

  thinkingLabel: { color: theme.dim, fontSize: 11, letterSpacing: 1, paddingVertical: 6 },
  thinking: { color: theme.dim, fontSize: 13, lineHeight: 19, paddingLeft: 10, borderLeftWidth: 1, borderLeftColor: theme.lineBright },

  err: { color: theme.rose, fontSize: 13, padding: 16 },

  // A question the agent asked, never collapsed.
  asked: { borderLeftWidth: 2, borderLeftColor: theme.peach, paddingLeft: 10, marginTop: 8, gap: 6 },
  askedQ: { color: theme.fg, fontSize: 15, fontWeight: "600" },
  askedOption: { gap: 1 },
  askedLabel: { color: theme.fg, fontSize: 14 },
  askedN: { color: theme.dim, fontFamily: theme.mono },
  askedWhy: { color: theme.dim, fontSize: 12 },

  // The file a call named, above the fold rather than behind the caret.
  toolFile: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, minHeight: 40 },
  toolFileName: { color: theme.peach, fontSize: 14, flexShrink: 1 },
  toolFileGo: { color: theme.dim, fontSize: 12 },

  fileSheet: { flex: 1, backgroundColor: theme.void },
  fileBar: { flexDirection: "row", alignItems: "center", gap: 12, padding: 16, paddingBottom: 4 },
  viewerName: { color: theme.fg, fontSize: 17, fontWeight: "600", flex: 1 },
  fileClose: { color: theme.peach, fontSize: 16 },
  filePath: { color: theme.dim, fontFamily: theme.mono, fontSize: 11, paddingHorizontal: 16, paddingBottom: 12 },
  fileWait: { marginTop: 32 },
  fileBody: { flex: 1, borderTopWidth: 1, borderTopColor: theme.line },
  fileText: { color: theme.fg, fontFamily: theme.mono, fontSize: 12, lineHeight: 18, padding: 16 },
  fileImage: { flex: 1, width: "100%" },

  tool: { marginBottom: 6 },
  toolHead: { flexDirection: "row", alignItems: "center", gap: 7, paddingVertical: 7 },
  toolCaret: { color: theme.lineBright, fontFamily: theme.mono, fontSize: 12 },
  toolName: { color: theme.dim, fontFamily: theme.mono, fontSize: 12 },
  toolSummary: { color: theme.dim, fontFamily: theme.mono, fontSize: 12, flex: 1 },
  toolErr: { color: theme.rose, fontFamily: theme.mono, fontSize: 11 },
  toolOut: { backgroundColor: theme.surface, borderRadius: 8, borderCurve: "continuous", padding: 10, marginBottom: 8, maxHeight: 260 },
  toolOutText: { color: theme.fg, fontFamily: theme.mono, fontSize: 11, lineHeight: 17 },
  toolAside: { color: theme.dim, fontFamily: theme.mono, fontSize: 11, marginBottom: 8 },

  image: {
    width: "100%",
    height: 220,
    borderWidth: 1,
    borderColor: theme.line,
    borderRadius: 8, borderCurve: "continuous",
    marginVertical: 6,
    backgroundColor: theme.surface,
  },
  imagePending: { alignItems: "center", justifyContent: "center", padding: 16 },

  promptCard: {
    margin: 16,
    borderWidth: 1,
    borderColor: theme.peach,
    borderRadius: 10, borderCurve: "continuous",
    backgroundColor: theme.surface,
    // A ScrollView grows to fill by default; the card is only as tall as its
    // question and options, up to its share of the screen.
    flexGrow: 0,
  },
  promptBody: { padding: 14 },
  question: { color: theme.fg, fontSize: 15, lineHeight: 21, marginBottom: 8 },
  choice: { flexDirection: "row", alignItems: "flex-start", gap: 8, minHeight: 44, paddingVertical: 10, borderRadius: 6, borderCurve: "continuous" },
  choiceArmed: { backgroundColor: theme.raised },
  cursor: { color: theme.peach, fontFamily: theme.mono, fontSize: 14, width: 12 },
  choiceIndex: { color: theme.dim, fontSize: 14 },
  choiceBody: { flex: 1 },
  choiceLabel: { color: theme.fg, fontSize: 14, lineHeight: 19 },
  /** The agent's own explanation of a choice, where it wrote one. */
  choiceDetail: { color: theme.dim, fontSize: 12, lineHeight: 17, marginTop: 3 },

  working: { flexDirection: "row", alignItems: "center", gap: 9, paddingVertical: 14 },
  workingSpin: { color: theme.working, fontFamily: theme.mono, fontSize: 13 },
  workingVerb: { color: theme.fg, fontSize: 13 },
  workingMeta: { color: theme.dim, fontSize: 12, flex: 1 },

  compose: { borderTopWidth: 1, borderTopColor: theme.line, padding: 10, gap: 8 },
  keys: { flexGrow: 0 },
  key: {
    minHeight: 44,
    paddingHorizontal: 12,
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.lineBright,
    borderRadius: 7, borderCurve: "continuous",
    marginRight: 6,
  },
  interruptKey: { marginLeft: 10, borderColor: theme.lineBright },
  keyText: { color: theme.dim, fontSize: 12 },
  composeRow: { flexDirection: "row", alignItems: "flex-end", gap: 4, padding: 5, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.lineBright, borderRadius: 16, borderCurve: "continuous" },
  attach: {
    width: 40,
    minHeight: 44,
    borderRadius: 10, borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
  attachText: { color: theme.dim, fontSize: 22, lineHeight: 24 },
  input: {
    flex: 1,
    backgroundColor: theme.surface,
    color: theme.fg,
    fontSize: 15,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 44,
    maxHeight: 120,
  },
  composeRowStacked: { flexWrap: "wrap" },
  // An empty multiline input is as tall as its wrapped placeholder. At AX5 the
  // 15pt text is about 47pt on 56pt lines, and even a full-width line wraps
  // "Reply to this agent…" once: 132pt with padding, over the 120 cap.
  inputStacked: { flexBasis: "100%", maxHeight: 200 },
  // Attach at the left (or an empty slot, keeping Send at the right), in the
  // order VoiceOver reads them.
  composeButtons: { flexBasis: "100%", flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end" },
  send: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 8, borderCurve: "continuous",
    backgroundColor: theme.peach,
    alignItems: "center",
    justifyContent: "center",
  },
  sendOff: { opacity: 0.35 },
  sendText: { color: theme.void, fontWeight: "600" },

  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.surface,
    borderTopWidth: 1,
    borderTopColor: theme.lineBright,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    gap: 8,
  },
  sheetHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sheetTitle: { color: theme.fg, fontSize: 17, fontWeight: "600" },
  sheetClose: { color: theme.peach, fontSize: 15 },
  fromPhone: { flexDirection: "row", gap: 8 },
  phoneButton: {
    flex: 1,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.lineBright,
    borderRadius: 8, borderCurve: "continuous",
  },
  phoneButtonText: { color: theme.peach, fontSize: 13 },
  uploadErr: { color: theme.rose, fontSize: 12 },
  sheetPath: { color: theme.dim, fontFamily: theme.mono, fontSize: 12 },
  sheetNote: { color: theme.dim, fontSize: 12, textAlign: "center" },
  fileRow: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44, paddingHorizontal: 4 },
  fileGlyph: { color: theme.dim, fontFamily: theme.mono, fontSize: 13 },
  fileName: { color: theme.fg, fontFamily: theme.mono, fontSize: 13, flex: 1 },
});
