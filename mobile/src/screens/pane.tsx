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
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { Stack } from "expo-router";
// The deep path is deliberate: SDK 57's expo-router vendors react-navigation
// wholesale, so a separately installed @react-navigation/elements would carry
// its own context and read a height of 0. This one shares the router's.
import { useHeaderHeight } from "expo-router/react-navigation";
import { useKeyboardHeight } from "@/lib/keyboard";
import { CopyOnHold } from "@/components/copy";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import type { Activity, LogBlock, LogMessage, ParsedPrompt, PromptOption } from "@shahi/shared";
import { api, connection, UnauthorizedError } from "@/lib/api";
import { coalesce } from "@/lib/coalesce";
import { committed, refused } from "@/lib/feel";
import { useSession } from "@/lib/session";
import { theme } from "@/lib/theme";
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
  { label: "esc", spoken: "Escape", keys: ["Escape"] },
  { label: "⇥", spoken: "Tab", keys: ["Tab"] },
  { label: "⇧⇥", spoken: "Shift Tab", keys: ["shift+tab"] },
  { label: "^C", spoken: "Control C", keys: ["C-c"] },
  { label: "↑", spoken: "Up arrow", keys: ["Up"] },
  { label: "↓", spoken: "Down arrow", keys: ["Down"] },
  { label: "⏎", spoken: "Return", keys: ["Enter"] },
];

/**
 * Where you were in each pane's transcript, for the life of the process.
 *
 * The scroll offset otherwise lives only inside the mounted list, and both
 * ways of leaving destroy that: popping the route unmounts the whole screen,
 * and the read/screen toggle unmounts just the list. Either way, coming back
 * silently threw the reader to the tail — or worse, the top. "bottom" is kept
 * as its own value so a pane left at the tail still opens at the tail, which
 * is where a pane you were not reading mid-scroll should open.
 *
 * A position is the id of the topmost visible message, not a pixel offset.
 * Offsets were tried and failed exactly where it matters — leaving the pane
 * and coming back: the remount re-estimates item heights, and the fetched
 * window shifts as the conversation grows, so the saved offset named a
 * different place, and the restore either landed wrong or wedged waiting
 * for a content height that never came back (leaving every later scroll
 * unrecorded, which read as "never remembered"). The message being read is
 * the place; its id survives both remeasurement and window drift.
 */
const scrollMemory = new Map<string, { id: string } | "bottom">();

/**
 * Folds a freshly fetched tail into what is already shown.
 *
 * Two properties carried over from the web reader, both load-bearing there:
 * messages older than the fetched window are kept, so scrolling back through
 * history survives the next poll; and unchanged messages keep their object
 * identity — a quiet poll returns the previous array itself — so the list
 * re-renders nothing when nothing changed. Only the last message can change
 * in place, so it is the only one compared by content.
 */
function merge(prev: LogMessage[], next: LogMessage[]): LogMessage[] {
  const start = next.length ? prev.findIndex((m) => m.id === next[0]!.id) : -1;
  if (start === -1) return next;
  const head = prev.slice(0, start);
  const prevById = new Map(prev.map((m) => [m.id, m] as const));
  const tail = next.map((m, i) => {
    const old = prevById.get(m.id);
    const last = i === next.length - 1;
    if (old && (!last || JSON.stringify(old) === JSON.stringify(m))) return old;
    return m;
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
  const [messages, setMessages] = useState<LogMessage[]>([]);
  /** Mirror of `messages`, so merging does not need a functional setState. */
  const messagesRef = useRef<LogMessage[]>([]);
  /**
   * Optimistic echo: your own reply, shown in the thread the instant you send,
   * before the transcript poll fetches it back. Reconciled away once the real
   * message lands (the transcript's `you` count passes this one's baseline) or
   * after a short timeout, so a dropped send cannot leave a ghost behind.
   */
  const [pending, setPending] = useState<{ message: LogMessage; youBaseline: number; at: number }[]>([]);
  const pendingSeq = useRef(0);
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
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [screen, setScreen] = useState<string | null>(null);
  /**
   * Reader or raw screen.
   *
   * The reader is the point of the app, but it only exists for agents that keep
   * a transcript. A plain shell has none, and without the screen there would be
   * nothing to look at while typing into it.
   */
  const [view, setView] = useState<"reader" | "screen">(initialView);
  /** A file a tool call named, once you have asked to see it. */
  const [viewing, setViewing] = useState<{ path: string; name: string } | null>(null);
  // Opens at the width Settings chose; the buttons on the screen still win.
  const { watch, onPaneFrame, session, terminalWidth, signOut } = useSession();
  const [columns, setColumns] = useState(terminalWidth);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<FlatList<LogMessage>>(null);
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
   * True while a remembered position is being restored. Scroll events are
   * ignored until it clears: they are the restore's own clamped settling, and
   * treating one as the reader's doing is how the position got overwritten.
   */
  const pendingRestore = useRef(typeof scrollMemory.get(paneId) === "object");
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
  /** Whether the restore's own deadline has been armed; see restore(). */
  const restoreArmed = useRef(false);
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
   * reports "the list stopped moving", so a deadline ends the restore — and
   * un-wedges one whose anchor can no longer land.
   */
  function restore() {
    const spot = scrollMemory.get(paneId);
    // Nothing fetched yet means nothing to judge: the anchor cannot have
    // "fallen out" of a window that does not exist. Now that the pane detail is
    // fetched alongside the transcript, the activity footer can render first
    // and change the content size before any message is here; judging then
    // would give up, jump to the tail and drop the pill. Waiting makes the
    // arrival order irrelevant.
    if (typeof spot === "object" && messagesRef.current.length === 0) return;
    const index =
      typeof spot === "object" ? messagesRef.current.findIndex((m) => m.id === spot.id) : -1;
    if (index < 0) {
      // The anchor fell out of the fetched window: the conversation moved on
      // past your place, and the tail is the closest honest answer.
      pendingRestore.current = false;
      following.current = true;
      scrollMemory.set(paneId, "bottom");
      setAway(false);
      listRef.current?.scrollToEnd({ animated: false });
      return;
    }
    if (!restoreArmed.current) {
      restoreArmed.current = true;
      // A backstop only. The restore normally ends the moment the anchor is
      // seen at the top of the viewport (in onScroll below); this exists for
      // an anchor that never lands, so scroll events are not ignored forever.
      // It used to be the *only* end, at 1.5s — and a retry that overshot to
      // the tail, then a slow measure, meant the list's own settle was read
      // as the reader scrolling to the bottom, which dropped the pill and the
      // place with it. Seen as a flake in the keep-your-place flow.
      setTimeout(() => {
        pendingRestore.current = false;
      }, 4_000);
    }
    listRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0 });
  }
  // What this pane is, as far as the dashboard knows. A plain shell is not an
  // agent, and asking someone to "reply" to their own bash prompt is nonsense.
  const pane = session?.panes.find((p) => p.paneId === paneId);
  // The native header sits above this screen, and "padding" measures from the
  // window — without the offset the composer stops a header's height short.
  const headerHeight = useHeaderHeight();
  const keyboard = useKeyboardHeight();

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

  const loadOnce = useCallback(async () => {
    // Both requests at once: neither depends on the other, and in sequence the
    // pane detail waited a full transcript round trip for nothing. Each is
    // awaited inside its own handler below so their failure modes stay
    // separate — a missing transcript is "not yet", a 401 is a sign-out.
    const logRequest = api.sessionLog(paneId, 60);
    const detailRequest = api.pane(paneId);
    logRequest.catch(() => undefined);
    detailRequest.catch(() => undefined);
    try {
      const log = await logRequest;
      const folded = merge(messagesRef.current, log.messages);
      if (folded !== messagesRef.current) {
        const prevLen = messagesRef.current.length;
        // Not on the first fill: a remount fetching the same conversation is
        // not "60 new" — unseen counts only what arrived while looking away.
        if (!following.current && prevLen > 0)
          setUnseen((u) => u + Math.max(0, folded.length - prevLen));
        messagesRef.current = folded;
        setMessages(folded);
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
      // audit.)
      if (e instanceof UnauthorizedError) return signOut();
      // No transcript *yet*. A just-started agent has not written one, so this
      // keeps polling rather than latching — the reader fills in by itself the
      // moment the agent says something.
      setReadable(false);
      setLoading(false);
    }
    try {
      const detail = await detailRequest;
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
      if (e instanceof UnauthorizedError) return signOut();
      // Transient; the next poll will catch up.
    }
  }, [paneId, signOut]);
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
    following.current = true;
    scrollMemory.set(paneId, "bottom");
    setAway(false);
    setUnseen(0);
    listRef.current?.scrollToEnd({ animated: true });
  }

  async function answer(option: PromptOption) {
    setPrompt(null);
    beginAwaiting();
    // Chase from the tap, not from the reply to the request: the agent starts
    // moving as soon as herdr has the key, and the fast poll should already be
    // running when it does.
    chase();
    try {
      await api.answerPrompt(paneId, option);
    } catch (e) {
      endAwaiting();
      setError((e as Error).message);
    }
  }

  async function submit() {
    const text = draft.trim();
    if (!text) return;
    setSending(true);
    // Echo the message into the thread and show "working", both before the send
    // round-trip — the reader reacts the instant you tap, not after a poll. The
    // baseline is the current `you` count so `load` can retire this echo once the
    // real message lands.
    const id = `pending-${(pendingSeq.current += 1)}`;
    const youNow = messagesRef.current.filter((m) => m.role === "you").length;
    const echo: LogMessage = { id, role: "you", at: Date.now(), blocks: [{ kind: "text", text }] };
    setPending((prev) => [...prev, { message: echo, youBaseline: youNow + prev.length, at: Date.now() }]);
    setDraft("");
    beginAwaiting();
    // Fast polling starts now, before the request even leaves. It used to start
    // after the send returned — which, when the send was two requests with a
    // 200ms pause between them, meant the first fast tick landed noticeably
    // after the agent had already begun. The send itself is one request now,
    // and the server confirms only that herdr accepted it; the haptic marks
    // that receipt.
    chase();
    try {
      await api.send(paneId, text);
      committed();
    } catch (e) {
      // The send did not land: pull the echo back and return the text to retry.
      setPending((prev) => prev.filter((p) => p.message.id !== id));
      setDraft(text);
      endAwaiting();
      refused();
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

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
          headerRight: () => (
            <View style={styles.toggle}>
              <Pressable
                style={[styles.toggleItem, view === "reader" && styles.toggleOn]}
                onPress={() => setView("reader")}
              >
                <Text style={[styles.toggleText, view === "reader" && styles.toggleTextOn]}>read</Text>
              </Pressable>
              <Pressable
                style={[styles.toggleItem, view === "screen" && styles.toggleOn]}
                onPress={() => setView("screen")}
              >
                <Text style={[styles.toggleText, view === "screen" && styles.toggleTextOn]}>screen</Text>
              </Pressable>
            </View>
          ),
        }}
      />

      {/* Readable and dismissible, instead of one truncated line squeezed
          into the old topbar. */}
      {error && (
        <Pressable style={styles.banner} onPress={() => setError(null)}>
          <Text style={styles.bannerText} numberOfLines={2}>{error}</Text>
          <Text style={styles.bannerClose}>✕</Text>
        </Pressable>
      )}

      {prompt && <Prompt prompt={prompt} onAnswer={answer} />}

      {loading ? (
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
            Claude and codex sessions appear here once the agent has said
            something. A plain shell keeps none at all.
          </Text>
          <Pressable style={styles.ghost} onPress={() => setView("screen")}>
            <Text style={styles.ghostText}>Show the screen instead</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.body}>
        <FlatList
          contentInsetAdjustmentBehavior="automatic"
          ref={listRef}
          data={pending.length ? [...messages, ...pending.map((p) => p.message)] : messages}
          keyExtractor={(m) => m.id}
          contentContainerStyle={styles.list}
          // Without this, the first tap anywhere in a scrollable only dismisses
          // the keyboard and is swallowed — so expanding a tool call or
          // pressing a key takes two taps while the composer has focus.
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <Message message={item} paneId={paneId} onOpenFile={setViewing} />
          )}
          // A long transcript is the other list RN can choke on. Detaching
          // off-screen messages and rendering a bounded window keeps scrolling
          // and each poll cheap; Message is already memoised and merge() keeps
          // unchanged messages' identity, so a poll re-renders only the tail.
          removeClippedSubviews
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
            following.current = false;
            pendingRestore.current = false;
          }}
          onScroll={({ nativeEvent: e }) => {
            if (pendingRestore.current) {
              // The restore has landed once the anchor is the topmost visible
              // message; from here the scroll events are the reader's own.
              const spot = scrollMemory.get(paneId);
              if (typeof spot === "object" && topItem.current === spot.id) {
                pendingRestore.current = false;
              }
              return;
            }
            const fromBottom =
              e.contentSize.height - e.layoutMeasurement.height - e.contentOffset.y;
            following.current = fromBottom < 80;
            scrollMemory.set(
              paneId,
              following.current || !topItem.current ? "bottom" : { id: topItem.current },
            );
            setAway(!following.current);
            if (following.current) setUnseen(0);
          }}
          scrollEventThrottle={200}
          // Any visible sliver counts: the anchor should be the message at the
          // top of the screen, not the first one half-past it.
          viewabilityConfig={{ itemVisiblePercentThreshold: 1 }}
          onViewableItemsChanged={trackTop}
          onScrollToIndexFailed={({ index, averageItemLength }) => {
            listRef.current?.scrollToOffset({
              offset: index * averageItemLength,
              animated: false,
            });
            setTimeout(() => {
              if (pendingRestore.current) restore();
            }, 100);
          }}
          onContentSizeChange={() => {
            if (pendingRestore.current) {
              restore();
              return;
            }
            if (following.current) listRef.current?.scrollToEnd({ animated: false });
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
            <Pressable style={styles.jump} onPress={jumpToLatest}>
              <Text style={styles.jumpText}>{unseen > 0 ? `${unseen} new ↓` : "Latest ↓"}</Text>
            </Pressable>
          </View>
        )}

        {/* Laid over the reader rather than replacing it, so flipping to the
            terminal and back never unmounts the list — which is what used to
            lose the scroll position. */}
        {view === "screen" && (
          <View style={styles.screenOverlay}>
            <Screen text={screen} columns={columns} onColumns={setColumns} />
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
              style={styles.key}
              accessibilityRole="button"
              accessibilityLabel={spoken}
              // Reported, not swallowed: this is how an unsupported key name
              // stayed invisible.
              onPress={() => {
                committed();
                api.sendKeys(paneId, keys).then(chase, (e: Error) => {
                  refused();
                  setError(e.message);
                });
              }}
            >
              <Text style={styles.keyText}>{label}</Text>
            </Pressable>
          ))}
        </ScrollView>
        )}
        <View style={styles.composeRow}>
          <Pressable
            style={styles.attach}
            onPress={() => setAttaching(true)}
            accessibilityRole="button"
            accessibilityLabel="Attach a file"
          >
            <Text style={styles.attachText}>+</Text>
          </Pressable>
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder={pane && !pane.isAgent ? "Run a command…" : "Reply to this agent…"}
            placeholderTextColor={theme.dim}
            multiline
          />
          <Pressable
            style={[styles.send, (sending || !draft.trim()) && styles.sendOff]}
            disabled={sending || !draft.trim()}
            onPress={() => void submit()}
          >
            <Text style={styles.sendText}>Send</Text>
          </Pressable>
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
  return (
    <View style={styles.promptCard}>
      <Text style={styles.question}>{prompt.question}</Text>
      {prompt.options.map((option) => {
        const isArmed = armed === option.index;
        return (
          <Pressable
            key={option.index}
            style={[styles.choice, isArmed && styles.choiceArmed]}
            disabled={armed !== null}
            onPress={() => {
              setArmed(option.index);
              void onAnswer(option).catch(() => setArmed(null));
            }}
          >
            <Text style={styles.cursor}>
              {isArmed || (armed === null && option.selected) ? "❯" : " "}
            </Text>
            {/* The digit is what the terminal takes; a cursor menu has none. */}
            {prompt.answer === "digit" && <Text style={styles.choiceIndex}>{option.index}.</Text>}
            <View style={styles.choiceBody}>
              <Text style={styles.choiceLabel}>{option.label}</Text>
              {option.detail && <Text style={styles.choiceDetail}>{option.detail}</Text>}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

// memo is what turns merge's identity-keeping into skipped work: with stable
// message objects and stable other props, an unchanged row never re-renders.
const Message = memo(function Message({
  message,
  paneId,
  onOpenFile,
}: {
  message: LogMessage;
  paneId: string;
  onOpenFile: (file: { path: string; name: string }) => void;
}) {
  const mine = message.role === "you";
  const system = message.role === "system";
  return (
    <View style={[styles.msg, mine && styles.msgYou, system && styles.msgSystem]}>
      <Text style={[styles.who, mine && styles.whoYou, system && styles.whoSystem]}>
        {mine ? "YOU" : system ? "SYSTEM" : "AGENT"}
      </Text>
      {message.blocks.map((block, i) => (
        <Block key={i} block={block} paneId={paneId} onOpenFile={onOpenFile} />
      ))}
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

  if (block.kind === "text") return <Markdown text={block.text} />;

  if (block.kind === "thinking") {
    return (
      <Pressable onPress={() => setOpen((o) => !o)}>
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
      <Pressable style={styles.toolHead} onPress={() => setOpen((o) => !o)}>
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
        <Pressable style={styles.toolFile} onPress={() => onOpenFile(block.file!)}>
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
      {open && !block.result && <Text style={styles.toolAside}>Still running.</Text>}
    </View>
  );
}

/**
 * A file an agent touched, read from the server rather than guessed at.
 *
 * Text and images come down one route and are told apart by content-type,
 * because the server is what decides — it serves HTML and SVG as `text/plain`
 * so agent-written markup cannot run anywhere, and reads are scoped to $HOME
 * and /tmp. There is deliberately no download: the cookie belongs to this
 * client, so handing the URL to Safari would only produce a 401.
 */
function FileView({
  file,
  onClose,
}: {
  file: { path: string; name: string };
  onClose: () => void;
}) {
  const [body, setBody] = useState<{ text: string } | { imageUrl: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void api
      .readFile(file.path)
      .then((result) => live && setBody(result))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [file.path]);

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet">
      <View style={styles.fileSheet}>
        <View style={styles.fileBar}>
          <Text style={styles.viewerName} numberOfLines={1}>
            {file.name}
          </Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={styles.fileClose}>Done</Text>
          </Pressable>
        </View>
        <Text style={styles.filePath} numberOfLines={1}>
          {file.path}
        </Text>

        {error ? (
          <Text style={styles.err}>{error}</Text>
        ) : !body ? (
          <ActivityIndicator color={theme.dim} style={styles.fileWait} />
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

/** Images come from the server rather than the transcript payload. */
function TranscriptImage({ paneId, imageRef }: { paneId: string; imageRef: string }) {
  const uri = `${connection.baseUrl}/api/panes/${encodeURIComponent(paneId)}/image?ref=${encodeURIComponent(imageRef)}`;
  return (
    <Image
      source={{ uri, headers: connection.cookie ? { cookie: connection.cookie } : undefined }}
      style={styles.image}
      resizeMode="contain"
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
  text,
  columns,
  onColumns,
}: {
  text: string | null;
  columns: number;
  onColumns: (columns: number) => void;
}) {
  const width = useWindowDimensions().width;
  const [aspect, setAspect] = useState(CHAR_ASPECT_GUESS);
  const fontSize = Math.max(6, Math.min(MAX_TERMINAL_FONT, (width - 24) / (columns * aspect)));

  const body = text ?? "Waiting for the pane…";
  // The text has to be given a width, or it wraps to the viewport. Sizing it to
  // the longest line is also what makes the horizontal scroll mean anything.
  const longest = body.split("\n").reduce((most, line) => Math.max(most, line.length), 0);

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
        <ScrollView horizontal>
          <ScrollView>
            <Text
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
            key={size}
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
function FilePicker({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (path: string) => void;
}) {
  const [path, setPath] = useState("~");
  const [entries, setEntries] = useState<
    { name: string; path: string; display: string; isDirectory: boolean }[]
  >([]);
  const [parent, setParent] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .dirs(path, true)
      .then((d) => {
        setEntries(d.entries);
        setParent(d.parent);
      })
      .catch(() => setEntries([]));
  }, [path]);

  /** Uploads to the server, then hands back where it landed. */
  async function upload(file: { uri: string; name: string; type: string }) {
    setUploading(true);
    setError(null);
    try {
      const stored = await api.upload(file);
      onPick(stored.path);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function fromPhotos() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError("Photo access was declined.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      quality: 1,
      // An iPhone photo is HEIC, and Claude Code's Read tool cannot open
      // one — "attach a photo, the agent says it can't read it" was the
      // report. Compatible asks the picker for the most broadly readable
      // representation, which transcodes HEIC to JPEG on the way out.
      preferredAssetRepresentationMode:
        ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    });
    const asset = result.assets?.[0];
    if (result.canceled || !asset) return;
    await upload({
      uri: asset.uri,
      name: asset.fileName ?? `photo.${asset.uri.split(".").pop() ?? "jpg"}`,
      type: asset.mimeType ?? "image/jpeg",
    });
  }

  async function fromFiles() {
    const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    const asset = result.assets?.[0];
    if (result.canceled || !asset) return;
    await upload({
      uri: asset.uri,
      name: asset.name,
      type: asset.mimeType ?? "application/octet-stream",
    });
  }

  return (
    <View style={styles.sheet}>
      <View style={styles.sheetHead}>
        <Text style={styles.sheetTitle}>Attach a file</Text>
        <Pressable onPress={onClose} hitSlop={12}>
          <Text style={styles.sheetClose}>Done</Text>
        </Pressable>
      </View>

      <View style={styles.fromPhone}>
        <Pressable style={styles.phoneButton} disabled={uploading} onPress={() => void fromPhotos()}>
          <Text style={styles.phoneButtonText}>Photo</Text>
        </Pressable>
        <Pressable style={styles.phoneButton} disabled={uploading} onPress={() => void fromFiles()}>
          <Text style={styles.phoneButtonText}>File on phone</Text>
        </Pressable>
      </View>
      {uploading && <Text style={styles.sheetNote}>Uploading…</Text>}
      {error && <Text style={styles.uploadErr}>{error}</Text>}

      <Text style={styles.sheetPath} numberOfLines={1}>{path}</Text>
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        data={parent ? [{ name: parent, path: parent, display: parent, isDirectory: true }, ...entries] : entries}
        keyExtractor={(e) => e.path}
        style={{ maxHeight: 320 }}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item, index }) => (
          <Pressable
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
      <Text style={styles.sheetNote}>Tap a file on the server to attach it. Folders open.</Text>
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

  headTitle: { alignItems: "center" },
  title: { color: theme.fg, fontFamily: theme.mono, fontSize: 14 },
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
  jumpText: { color: theme.peach, fontFamily: theme.mono, fontSize: 12 },

  screenOverlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: theme.void },
  // No boxes at all: two labels, the active one lit. Every boxed version —
  // square-in-rounded, then pill-in-pill — read as shapes fighting shapes.
  toggle: { flexDirection: "row", gap: 16 },
  toggleItem: { minHeight: 44, justifyContent: "center", paddingHorizontal: 4 },
  toggleOn: {},
  toggleText: { color: theme.dim, fontFamily: theme.mono, fontSize: 12 },
  toggleTextOn: { color: theme.peach, fontWeight: "700" },

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
  widthOn: { borderColor: theme.peach },
  widthText: { color: theme.dim, fontFamily: theme.mono, fontSize: 12 },
  widthTextOn: { color: theme.peach },
  ghost: {
    marginTop: 6,
    minHeight: 44,
    paddingHorizontal: 16,
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.lineBright,
    borderRadius: 8, borderCurve: "continuous",
  },
  ghostText: { color: theme.peach, fontFamily: theme.mono, fontSize: 13 },

  list: { padding: 16 },
  msg: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: theme.line },
  msgYou: {
    backgroundColor: theme.surface,
    borderLeftWidth: 2,
    borderLeftColor: theme.peach,
    borderBottomWidth: 0,
    borderRadius: 8, borderCurve: "continuous",
    paddingHorizontal: 12,
    marginVertical: 8,
  },
  who: { color: theme.dim, fontFamily: theme.mono, fontSize: 10, letterSpacing: 1.2, marginBottom: 6 },
  whoYou: { color: theme.peach },
  // A system note (a model switch, an away-summary): quiet chrome, not the
  // agent speaking — dim, set off by a rule, never the loud "you" fill.
  msgSystem: { borderLeftWidth: 2, borderLeftColor: theme.lineBright, paddingHorizontal: 12, opacity: 0.85 },
  whoSystem: { color: theme.dim },

  thinkingLabel: { color: theme.dim, fontFamily: theme.mono, fontSize: 11, letterSpacing: 1, paddingVertical: 6 },
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
  toolName: { color: theme.mint, fontFamily: theme.mono, fontSize: 12 },
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

  promptCard: {
    margin: 16,
    borderWidth: 1,
    borderColor: theme.peach,
    borderRadius: 10, borderCurve: "continuous",
    backgroundColor: theme.surface,
    padding: 14,
  },
  question: { color: theme.fg, fontSize: 15, lineHeight: 21, marginBottom: 8 },
  choice: { flexDirection: "row", alignItems: "flex-start", gap: 8, minHeight: 44, paddingVertical: 10, borderRadius: 6, borderCurve: "continuous" },
  choiceArmed: { backgroundColor: theme.raised },
  cursor: { color: theme.peach, fontFamily: theme.mono, fontSize: 14, width: 12 },
  choiceIndex: { color: theme.dim, fontFamily: theme.mono, fontSize: 14 },
  choiceBody: { flex: 1 },
  choiceLabel: { color: theme.fg, fontFamily: theme.mono, fontSize: 14, lineHeight: 19 },
  /** The agent's own explanation of a choice, where it wrote one. */
  choiceDetail: { color: theme.dim, fontSize: 12, lineHeight: 17, marginTop: 3 },

  working: { flexDirection: "row", alignItems: "center", gap: 9, paddingVertical: 14 },
  workingSpin: { color: theme.peach, fontFamily: theme.mono, fontSize: 13 },
  workingVerb: { color: theme.fg, fontFamily: theme.mono, fontSize: 13 },
  workingMeta: { color: theme.dim, fontFamily: theme.mono, fontSize: 12, flex: 1 },

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
  keyText: { color: theme.dim, fontFamily: theme.mono, fontSize: 12 },
  composeRow: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  attach: {
    width: 44,
    minHeight: 44,
    borderWidth: 1,
    borderColor: theme.lineBright,
    borderRadius: 8, borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
  attachText: { color: theme.dim, fontSize: 22, lineHeight: 24 },
  input: {
    flex: 1,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.lineBright,
    borderRadius: 8, borderCurve: "continuous",
    color: theme.fg,
    fontFamily: theme.mono,
    fontSize: 15,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 44,
    maxHeight: 120,
  },
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
  phoneButtonText: { color: theme.peach, fontFamily: theme.mono, fontSize: 13 },
  uploadErr: { color: theme.rose, fontSize: 12 },
  sheetPath: { color: theme.dim, fontFamily: theme.mono, fontSize: 12 },
  sheetNote: { color: theme.dim, fontSize: 12, textAlign: "center" },
  fileRow: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44, paddingHorizontal: 4 },
  fileGlyph: { color: theme.dim, fontFamily: theme.mono, fontSize: 13 },
  fileName: { color: theme.fg, fontFamily: theme.mono, fontSize: 13, flex: 1 },
});
