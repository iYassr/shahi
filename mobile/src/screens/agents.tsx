
import { UiText } from "@/components/ui-text";
import { useI18n } from "@/lib/i18n";
import { plainHeaderRight } from "@/lib/header-controls";
import { ComputerUpdate } from "@/components/computer-update";
import { ComputerSwitcher } from "@/components/computer-switcher";
import { LinkBadge } from "@/components/link-badge";
import { connectionHealth } from "@shahi/shared";
import { ConnectionHealth } from "@/components/connection-health";
import { OtherComputers } from "@/components/other-computers";
import { SaveProblem } from "@/components/save-problem";
import { agentLabel, answerRefused, backendUnavailable, inboxKind, inboxPanes, latestConversations, promptIdentity as identityOf, reviewKey, rowPreview, rowTime, shownLabels, type AnsweredPrompt, type LogMessage } from "@shahi/shared";
/** Conversations follow their latest message; Inbox remains an attention queue. */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Text, useLargeText } from "@/components/text";
import { useRememberedScroll } from "@/lib/scroll-memory";
import { RectButton } from "react-native-gesture-handler";
import ReanimatedSwipeable, { type SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { router, Stack } from "expo-router";
import type { DashboardPane, ParsedPrompt, PromptOption } from "@shahi/shared";
import { committed, landed, refused } from "@/lib/feel";
import { openScreen } from "@/lib/navigate";
import { useSession } from "@/lib/session";
import { GreetingLogo } from "@/components/greeting-logo";
import { theme, statusColor } from "@/lib/theme";
import { AgentIcon, Icon, type IconName } from "@/components/icons";
import { Avatar } from "@/components/avatar";
import { conversationLabel, paneTitle, rowAt } from "@/components/conversation-label";
import * as Clipboard from "expo-clipboard";
import { PromptContext } from "@/components/prompt-context";
import { Unreachable } from "@/components/unreachable";
import { shouldTakeOverSession } from "@/lib/agents-error";

export function Agents({ onOpenPane, focused = true }: { onOpenPane: (paneId: string, reply?: boolean) => void; focused?: boolean }) {
  const { t: ui, locale } = useI18n();
  const openSwipe = useRef<SwipeableMethods | null>(null);
  const closeSwipe = useCallback(() => { openSwipe.current?.close(); openSwipe.current = null; }, []);
  const rememberSwipe = useCallback((swipe: SwipeableMethods) => {
    if (openSwipe.current !== swipe) openSwipe.current?.close();
    openSwipe.current = swipe;
  }, []);
  useEffect(() => { if (!focused) closeSwipe(); }, [focused, closeSwipe]);
  // Where this list was, restored when you come back from a conversation.
  // Declared here, above the early returns below, because a hook cannot be
  // called conditionally; the rows are read lazily when the restore happens.
  const rows = useRef<DashboardPane[]>([]);
  const { api, reviewed, markReviewed, session, prompts, answered, link, error, answeredPrompt, refresh, pins, togglePin, server, reconnect, activeComputerId, control, computers = [], accessEnded } = useSession();
  const current = computers.find(c => c.id === activeComputerId);
  const computerName = current?.named === false ? undefined : current?.name;
  // Nothing a card offers can be answered while herdr is not running, though
  // the socket, and so the list, stays up (pre-release bug hunt).
  const backend = control?.handshake?.backend;
  const herdrAway = link !== "live" || !!error || backendUnavailable(error) || !!backend && backend.state !== "connected";
  // This computer's place in its own list; see scroll-memory.
  const agentScroll = useRememberedScroll("agents", () => rows.current, (p) => p.paneId, api);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  /** The row a long-press opened actions for. */
  const [acting, setActing] = useState<DashboardPane | null>(null);
  useEffect(() => { if (!focused) setActing(null); }, [focused]);
  // Rows say how long ago they moved; a minute's tick keeps "5m" from staying
  // "5m" for an hour on a list nothing else changed. Only while on screen.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!focused) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [focused]);
  const openScreenHere = useCallback((paneId: string) => openScreen(paneId, activeComputerId), [activeComputerId]);

  /**
   * The whole of the agent's last written reply, from its transcript: the
   * row's preview is cut at 160 characters and stripped of Markdown, so
   * copying it would hand over less than was said.
   */
  async function copyLastReply(pane: DashboardPane) {
    try {
      const page = await api.sessionLog(pane.paneId, 12);
      const reply = [...page.messages].reverse().find((message: LogMessage) => message.role === "agent" && message.blocks.some((block) => block.kind === "text" && block.text.trim()));
      const text = reply?.blocks.flatMap((block) => (block.kind === "text" ? [block.text] : [])).join("\n\n").trim();
      if (!text) { refused(); AccessibilityInfo.announceForAccessibility(ui("No reply to copy yet")); return; }
      await Clipboard.setStringAsync(text);
      committed();
      AccessibilityInfo.announceForAccessibility(ui("Last reply copied"));
    } catch {
      refused();
      AccessibilityInfo.announceForAccessibility(ui("Could not copy the last reply"));
    }
  }

  // Rejects on failure so the card that asked can say why and offer its
  // options again: a relay timeout is an ordinary outcome, not an exception
  // to swallow. A 409 is not a failure to retry: the question moved on and
  // nothing was pressed. The card stops offering it and the session is read
  // again for whatever the agent asks now; it used to show the server's
  // "w1:p1 is not asking anything now" and re-arm the same dead options
  // (pre-release bug hunt).
  async function answer(paneId: string, option: PromptOption) {
    const shown = prompts[paneId];
    try {
      await api.answerPrompt(paneId, option, shown, session?.panes.find((pane) => pane.paneId === paneId)?.instanceId);
    } catch (e) {
      refused();
      if (!answerRefused(e)) throw e;
      answeredPrompt(paneId, shown, "closed");
      void refresh();
      return;
    }
    landed();
    if (option.textInput) { onOpenPane(paneId, true); return; }
    answeredPrompt(paneId, shown, "sent");
  }

  // Only take over the whole screen when there is nothing to show yet. Once a
  // session is on screen, a transient error must not replace the live list —
  // the next successful poll clears it (see `refresh`), and blanking the herd
  // over one blip was the "sticky failure" this review flagged.
  //
  // When the server could not be read at all, say so properly: what was tried,
  // what to check, a way to retry and a way out. The platform's own words used
  // to land here — "A server with the specified hostname could not be found. at
  // ExpoModulesCore/Promise.swift:56" — which reads as a crash, not a network.
  // A transient failure should leave the last useful snapshot on screen, but
  // an incompatible snapshot is not useful: every action against it will be
  // refused. Always replace stale data with the upgrade instructions for a
  // 426, including when the server changed versions while the app was open.
  // Just the server and whether it is talking — the waiting count was the
  // card's job said twice, and the bell now lives in Settings. Given on every
  // path below, and the badge reads the session itself: a header keeps the
  // last options a screen set, and the error path used to set none.
  const header = (
    <Stack.Screen
      options={{
        title: ui("Agents"),
        headerLargeTitle: false,
        headerLeft: () => <GreetingLogo size={36} />,
        ...plainHeaderRight(
          <View style={styles.status}>
            <ComputerSwitcher />
            <LinkBadge />
          </View>
        ),
      }}
    />
  );
  if (error && shouldTakeOverSession(error, session)) {
    return (
      <View style={{ flex: 1 }}>{header}<ComputerUpdate /><Unreachable
        title={connectionHealth({ locale: locale, link, error, computerName, transport: server.startsWith("ssh:") ? "ssh" : "relay" })?.title ?? ui("Connection interrupted")}
        message={connectionHealth({ locale: locale, link, error, transport: server.startsWith("ssh:") ? "ssh" : "relay" })?.detail ?? error.message}
        server={computerName || server}
        onRetry={reconnect}
        onSwitch={() => router.push("/computers")}
        alternatives={<OtherComputers />}
      /></View>
    );
  }
  if (!session) {
    return (
      <View style={styles.centered}>
        {header}
        <ActivityIndicator color={theme.peach} />
        <UiText style={styles.dim}>Connecting to your computer…</UiText>
      </View>
    );
  }

  const inbox = inboxPanes(session.panes, reviewed);
  const agents = session.panes.filter((p) => p.isAgent);
  const shells = session.panes.filter((p) => !p.isAgent);

  /*
   * The filter row, in WhatsApp's grammar but with this app's nouns: not
   * "Unread / Favourites / Groups" but Waiting, each agent kind actually
   * running, and Shells. Derived from the session rather than declared, so a
   * kind that is not running is not offered — and Shells only exists here as
   * an explicit ask, because burying agents under shells is what the Agents
   * view exists to avoid.
   */
  const kinds = [...new Set(agents.map((p) => p.agent).filter((a): a is string => !!a))].sort();
  const waiting = agents.filter((p) => p.status === "blocked").length;
  const chips: { id: string; label: string; icon?: IconName; count?: number }[] = [
    { id: "all", label: ui("All") },
    { id: "inbox", label: ui("Inbox {value1}", {value1: inbox.length}), icon: "inbox", count: inbox.length },
    ...(waiting > 0 ? [{ id: "waiting", label: ui("Waiting {value1}", {value1: waiting}) }] : []),
    ...kinds.map((k) => ({ id: `kind:${k}`, label: agentLabel(k),
      icon: (k === "claude" ? "claudecode" : k === "codex" ? "openai" : undefined) as IconName | undefined })),
    ...(shells.length > 0 ? [{ id: "shells", label: ui("Shells") }] : []),
  ];

  // A chip can vanish under its selection — the last codex exits, the waiting
  // agent gets its answer. Falling back to All beats an empty screen filtered
  // by a control that is no longer on it.
  const active = chips.some((c) => c.id === filter) ? filter : "all";
  const filtered =
    active === "inbox" ? inbox : active === "all"
      ? agents
      : active === "waiting"
        ? agents.filter((p) => p.status === "blocked")
        : active === "shells"
          ? shells
          : agents.filter((p) => `kind:${p.agent}` === active);
  const search = query.trim().toLocaleLowerCase();
  const shown = search ? filtered.filter(p =>
    [p.title, p.workspaceLabel, p.cwd, agentLabel(p.agent ?? "shell")].some(value => value?.toLocaleLowerCase().includes(search))) : filtered;
  const blocked = active === "inbox" ? latestConversations(shown.filter(p => p.status === "blocked")) : [];
  const rest = latestConversations(active === "inbox" ? shown.filter(p => p.status !== "blocked") : shown, pins);
  rows.current = rest;

  return (
    <View style={styles.screen}>
      {/* No strip of its own above the list for an unavailable computer. It
          stood here, fixed, to keep "unavailable" in sight once the card
          scrolled away (review M5, September 2026), but the header's word
          (OFFLINE, HERDR OFFLINE) stays in sight on every screen already,
          and its "Other computers" is the header's switcher and the card's
          Switch computer. On build 32 it was one of four things saying an
          offline computer was offline, which pushed the agents off screen. */}
      {header}
      <FlatList
        {...agentScroll}
        onScrollBeginDrag={closeSwipe}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        // The native tab bar floats over the list; without room past it the
        // last agent sits under the bar and a tap on it lands on the tab
        // instead — the more so since the "+ New agent" header pushed the list
        // down. Padding lets the last row scroll clear of the bar.
        contentContainerStyle={styles.listContent}
        data={rest}
        keyExtractor={(p) => p.paneId}
        ListHeaderComponent={
          <>
            <SaveProblem />
            <ComputerUpdate />
            <ConnectionHealth />
            {accessEnded && <Text style={styles.notice} accessibilityRole="alert">{accessEnded}</Text>}
            {!herdrAway && <View style={{ marginHorizontal: 16 }}><OtherComputers waitingOnly /></View>}
            <View style={styles.search}>
              <TextInput accessibilityLabel={ui("Search agents")} placeholder={ui("Search agents, spaces or folders")}
                placeholderTextColor={theme.dim} value={query} onChangeText={setQuery}
                autoCorrect={false} autoCapitalize="none" returnKeyType="search"
                style={styles.searchInput} testID="search-agents" />
              {!!query && <Pressable accessibilityRole="button" accessibilityLabel={ui("Clear search")} style={styles.searchClear} onPress={() => setQuery("")}><UiText style={{ color: theme.peach }}>Clear</UiText></Pressable>}
            </View>
            {/* Inside the list, not above it: content outside the FlatList
                gets no inset for the transparent large-title header and drew
                behind the clock — the first safe-area bug, wearing a new hat.
                WhatsApp's chips scroll with the content anyway. */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.filters}
            >
              {chips.map((chip) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={chip.label}
                  accessibilityHint={chip.id.startsWith("kind:") || chip.id === "shells" ? ui("Show {value1} conversations", {value1: chip.label}) : undefined}
                  accessibilityState={{ selected: chip.id === active }}
                  key={chip.id}
                  style={[styles.filter, chip.id === active && styles.filterOn]}
                  onPress={() => setFilter(chip.id)}
                >
                  {chip.id.startsWith("kind:") || chip.id === "shells" ? <AgentIcon kind={chip.id === "shells" ? "shell" : chip.id.slice(5)} size={20} /> : chip.icon ? <Icon name={chip.icon} size={20} color={chip.id === active ? theme.fg : theme.dim} /> : null}
                  {/* Named in words as well as drawn. Unselected agent and
                      shell chips were a logo alone, and a new person could not
                      tell a terminal glyph from a filter (simulator run of
                      build 32); the row scrolls, so the words cost nothing. */}
                  <Text style={[styles.filterText, chip.id === active && styles.filterTextOn]}>
                    {chip.label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            {/* Where the work starts, not three taps away under Spaces: the
                sheet asks which space, then the same form a space opens. */}
            <Pressable accessibilityRole="button" disabled={herdrAway} accessibilityState={{ disabled: herdrAway }} style={[styles.newAgent, herdrAway && { opacity: 0.5 }]} onPress={() => router.push("/new-agent")} testID="new-agent">
              <UiText style={styles.newAgentText}>+ New agent</UiText>
            </Pressable>
            {active === "inbox" && <View style={styles.inboxHeading}><UiText style={styles.inboxTitle}>What needs me?</UiText><UiText style={styles.dim}>Reply to questions, check unavailable agents, and review completed work.</UiText></View>}
            {/* One tap for a morning's finished work, rather than one per row.
                Nothing is lost: new activity brings a conversation back. */}
            {active === "inbox" && rest.filter((pane) => inboxKind(pane) === "review").length > 1 && (
              <Pressable accessibilityRole="button" style={styles.reviewAll} testID="mark-all-reviewed"
                onPress={() => { for (const pane of rest) if (inboxKind(pane) === "review") markReviewed(pane); committed(); }}>
                <UiText style={styles.reviewedText}>Mark all reviewed</UiText>
              </Pressable>
            )}
            {blocked.map((pane) => (
              <BlockedCard
                key={`${pane.paneId}\u0000${promptIdentity(prompts[pane.paneId])}`}
                pane={pane}
                prompt={prompts[pane.paneId]}
                answered={answered[pane.paneId]}
                stale={herdrAway}
                onAnswer={(option) => answer(pane.paneId, option)}
                onOpen={() => onOpenPane(pane.paneId)}
              />
            ))}
            {rest.length > 0 && (
              <Text style={styles.groupLabel}>
                {active === "inbox" ? ui("UPDATES") : blocked.length > 0
                  ? ui("EVERYTHING ELSE")
                  : `${rest.length} ${active === "shells" ? "SHELL" : "AGENT"}${rest.length === 1 ? "" : "S"}`}
              </Text>
            )}
          </>
        }
        renderItem={({ item }) => (
          <View>
          {active === "inbox" && <UiText style={styles.inboxLabel}>{item.status === "done" ? "Ready to review" : "Status unavailable"}</UiText>}
          {item.status === "blocked" ? <BlockedCard key={promptIdentity(prompts[item.paneId])} pane={item} prompt={prompts[item.paneId]}
            answered={answered[item.paneId]} stale={herdrAway} onAnswer={(option) => answer(item.paneId, option)} onOpen={() => onOpenPane(item.paneId)} /> : <Row
            pane={item}
            pinned={pins.has(item.paneId)}
            onPress={onOpenPane}
            onScreen={openScreenHere}
            onPin={togglePin}
            onActions={setActing}
            onSwipe={rememberSwipe}
            now={now}
          />}
          {active === "inbox" && item.status === "done" && <Pressable accessibilityRole="button" accessibilityLabel={ui("Mark {value1} reviewed", {value1: paneTitle(item)})} style={styles.reviewed} onPress={() => markReviewed(item)}><UiText style={styles.reviewedText}>Mark reviewed</UiText></Pressable>}
          </View>
        )}
        // Virtualization tuning: RN warned this list was "slow to update"
        // because every session snapshot re-rendered all rows (each with an
        // animated avatar). Rendering only a small window around the viewport
        // and detaching off-screen rows keeps an update cheap; the memoised Row
        // above skips the rows that did not change.
        removeClippedSubviews
        initialNumToRender={10}
        maxToRenderPerBatch={8}
        windowSize={7}
        // WhatsApp's hairline, starting past the avatar so the circles read
        // as one column.
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={
          blocked.length ? null : (
            <Centered>{ui(search ? "No matching conversations. Try another name, space or folder." : active === "inbox" ? "You’re caught up. New requests and completed work will appear here." : active === "all" ? "No agents running." : "Nothing here right now.")}</Centered>
          )
        }
      />

      {/* An in-app sheet rather than ActionSheetIOS or Modal: the native
          sheet's buttons dropped synthesized taps on iOS 26, and Modal mounts
          a second window the test driver cannot see into. An overlay in the
          same tree is visible to everything that can see the screen. */}
      {acting && (
        <View style={styles.sheetLayer}>
          {/* The backdrop is a sibling of the card, not its parent: a
              pressable flattens its children into one element, and the whole
              sheet inside it became a single untappable blob. */}
          <Pressable accessibilityRole="button" accessibilityLabel={ui("Dismiss actions")} style={styles.sheetBack} onPress={() => setActing(null)} />
          <View style={styles.sheetCard}>
              <Text style={styles.sheetTitle} numberOfLines={1}>
                {paneTitle(acting)}
              </Text>
              <Pressable
                accessibilityRole="button"
                style={styles.sheetItem}
                onPress={() => {
                  togglePin(acting.paneId);
                  setActing(null);
                }}
              >
                <Icon name={pins.has(acting.paneId) ? "pin-off" : "pin"} color={theme.peach} size={16} />
                <UiText style={styles.sheetItemText}>
                  {pins.has(acting.paneId) ? "Unpin" : "Pin"}
                </UiText>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                style={styles.sheetItem}
                onPress={() => {
                  setActing(null);
                  openScreen(acting.paneId, activeComputerId);
                }}
              >
                <Icon name="terminal" color={theme.mint} size={16} />
                <UiText style={styles.sheetItemText}>Open screen</UiText>
              </Pressable>
              {inboxKind(acting) === "review" && reviewed[acting.paneId] !== reviewKey(acting) && (
                <Pressable
                  accessibilityRole="button"
                  style={styles.sheetItem}
                  onPress={() => {
                    markReviewed(acting);
                    setActing(null);
                  }}
                >
                  <Icon name="check" color={theme.mint} size={16} />
                  <UiText style={styles.sheetItemText}>Mark reviewed</UiText>
                </Pressable>
              )}
              {acting.isAgent && !!acting.preview && (
                <Pressable
                  accessibilityRole="button"
                  style={styles.sheetItem}
                  onPress={() => {
                    const pane = acting;
                    setActing(null);
                    void copyLastReply(pane);
                  }}
                >
                  <Icon name="copy" color={theme.dim} size={16} />
                  <UiText style={styles.sheetItemText}>Copy last reply</UiText>
                </Pressable>
              )}
              <Pressable accessibilityRole="button" style={styles.sheetItem} onPress={() => setActing(null)}>
                <UiText style={[styles.sheetItemText, { color: theme.dim }]}>Cancel</UiText>
              </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

/**
 * A chat-list row, in the grammar every messenger taught: who, the last thing
 * said, and whether they are typing. An agent session is a conversation, and
 * a row that reads "I've finished the parser — run the tests?" tells you more
 * than a status glyph ever did. The blocked card above stays a card — a
 * conversation that needs a decision does not queue politely in a list.
 *
 * Swiping reveals the two things worth doing without opening it: keeping it
 * on top, and going straight to the raw terminal.
 */
const Row = memo(function Row({
  pane,
  pinned,
  onPress,
  onScreen,
  onPin,
  onActions,
  onSwipe,
  now,
}: {
  pane: DashboardPane;
  pinned: boolean;
  /** The list's minute tick, so a row's age is redrawn as it grows. */
  now: number;
  // Stable callbacks that take the pane, so memo actually holds: inline
  // closures would give every row a new identity on each list render.
  onPress: (paneId: string) => void;
  onScreen: (paneId: string) => void;
  onPin: (paneId: string) => void;
  onActions: (pane: DashboardPane) => void;
  onSwipe: (swipe: SwipeableMethods) => void;
}) {
  const { t: ui, locale } = useI18n();
  const largeText = useLargeText();
  const swipe = useRef<SwipeableMethods | null>(null);
  const at = rowAt(pane);
  const said = rowPreview(pane);
  const row = (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={conversationLabel(pane, pane.workspaceLabel, pinned, now, locale)}
        style={styles.row}
        // The pinned state rides in the row's own id: children of a pressable
        // flatten into one accessibility element, so a marker inside it is
        // invisible to the test driver — the row's id is not.
        testID={`row-${pane.paneId}${pinned ? "-pinned" : ""}`}
        onPress={() => { swipe.current?.close(); onPress(pane.paneId); }}
        // The same actions as the swipe, reachable without knowing the swipe
        // exists.
        onLongPress={() => onActions(pane)}
      >
        <Avatar pane={pane} />
        <View style={styles.rowBody}>
          <View style={[styles.rowLine, largeText && { flexDirection: "column", alignItems: "stretch" }]}>
            <Text style={[styles.rowTitle, largeText && { flex: 0 }]} numberOfLines={largeText ? 2 : 1}>
              {paneTitle(pane)}
            </Text>
            {pinned && <Icon name="pin" color={theme.dim} size={12} />}
            {/* "idle" is the resting state of most of a real herd; saying it
                twenty-six times is what made the list feel crowded. Only a
                state that asks something of you gets a word. */}
            <View style={{ flexDirection: "row", gap: 8, flexShrink: 1, maxWidth: largeText ? "100%" : "50%" }}>
            {pane.status !== "idle" && (
              <Text style={[styles.rowStatus, { color: statusColor(pane.status) }]}>
                {ui(pane.status === "blocked" ? "waiting" : pane.status)}
              </Text>
            )}
            <Text style={[styles.rowMeta, { flexShrink: 1 }]} numberOfLines={1}>{pane.workspaceLabel}</Text>
            {/* Last, and never shortened: a cut "Yester…" says nothing. */}
            {at !== null && <Text style={styles.rowTime} testID={`time-${pane.paneId}`}>{rowTime(at, now, locale)}</Text>}
            </View>
          </View>
          {/* The last thing said; for an agent that has said nothing, that it
              has not, dimmed; for a shell, its folder from home. The full
              working folder stood here once, and repeated what the space tag
              already said while pushing the rest off the row (build 28 audit). */}
          {(pane.activity || said) && (
            <View style={styles.rowLine}>
              {pane.activity ? (
                // What "typing…" means when the other party is an agent.
                <Text style={[styles.rowSaid, styles.rowTyping]} numberOfLines={1}>
                  {pane.activity.verb}… {pane.activity.elapsed}
                </Text>
              ) : (
                <Text style={[styles.rowSaid, !pane.preview && pane.isAgent && styles.rowQuiet]} numberOfLines={1}>
                  {said}
                </Text>
              )}
            </View>
          )}
        </View>
      </Pressable>
  );
  return (
    <ReanimatedSwipeable
      ref={swipe}
      onSwipeableWillOpen={() => { if (swipe.current) onSwipe(swipe.current); }}
      friction={2}
      rightThreshold={40}
      overshootRight={false}
      renderRightActions={(_progress, _drag, swipeable_) => (
        // RectButton, not Pressable: inside the swipeable's gesture territory
        // a plain touchable's press never fires — the library's own buttons
        // are how the actions stay tappable.
        <View style={styles.actions}>
          <RectButton
            style={styles.action}
            onPress={() => {
              swipeable_.close();
              onPin(pane.paneId);
            }}
          >
            <Icon name={pinned ? "pin-off" : "pin"} color={theme.peach} />
            <UiText style={styles.actionText}>{pinned ? "Unpin" : "Pin"}</UiText>
          </RectButton>
          <RectButton
            style={styles.action}
            onPress={() => {
              swipeable_.close();
              onScreen(pane.paneId);
            }}
          >
            <Icon name="terminal" color={theme.mint} />
            <UiText style={styles.actionText}>Screen</UiText>
          </RectButton>
        </View>
      )}
    >
      {row}
    </ReanimatedSwipeable>
  );
});

/**
 * Which question a card is showing. The card is keyed by it, so a new
 * question on a still-blocked pane starts with every option live again
 * instead of inheriting the tapped state of the one before.
 */
function promptIdentity(prompt: ParsedPrompt | undefined): string {
  return prompt ? identityOf(prompt) : "";
}

/**
 * The answer list, rebuilt from the terminal's own — same numbering, same
 * cursor, sized for a thumb.
 */
function BlockedCard({
  pane,
  prompt,
  answered,
  stale = false,
  onAnswer,
  onOpen,
}: {
  pane: DashboardPane;
  prompt: ParsedPrompt | undefined;
  /** This phone's answer to the question the card last showed, while the pane still waits. */
  answered?: AnsweredPrompt;
  /** herdr is not running: the question is as it was last seen, and cannot be answered. */
  stale?: boolean;
  /** Rejects when the answer did not land; the card then offers its options again. */
  onAnswer: (option: PromptOption) => Promise<void>;
  onOpen: () => void;
}) {
  const { t: ui } = useI18n();
  const [armed, setArmed] = useState<number | null>(null);
  // Said inside the card that failed. It used to go to a screen-level message
  // that rendered only when there was no session — never, with this list on
  // screen — so a 409 or a relay timeout left one option lit and every option
  // dead, with a haptic and no words (found by the September 2026 review).
  const [failure, setFailure] = useState<string | null>(null);
  const largeText = useLargeText();

  function choose(option: PromptOption) {
    setArmed(option.index);
    setFailure(null);
    onAnswer(option).catch((e: unknown) => {
      const message = `Couldn’t answer: ${e instanceof Error ? e.message : String(e)}`;
      setArmed(null);
      setFailure(message);
      AccessibilityInfo.announceForAccessibility(message);
    });
  }

  const title = paneTitle(pane);
  const kind = agentLabel(pane.agent ?? "agent");
  const labels = prompt ? shownLabels(prompt.options) : [];
  return (
    <View style={styles.blocked}>
      <Pressable accessibilityRole="button" accessibilityLabel={[ui("Waiting on you"), title, pane.workspaceLabel, kind === title ? null : kind].filter(Boolean).join(", ")} onPress={onOpen}>
        <UiText style={[styles.badge, answered && { color: theme.dim }]}>{answered ? "ANSWER SENT" : "● WAITING ON YOU"}</UiText>
        {/* The title gets a line of its own, first: it is what tells two
            waiting agents in one space apart. It used to come last on one
            truncated line after the agent and pane id, which at accessibility
            sizes showed "claude · w3:p…" and no title at all (September 2026
            review). */}
        <Text style={styles.where} numberOfLines={largeText ? 3 : 2}>
          {title}
        </Text>
        <Text style={styles.task} numberOfLines={largeText ? 2 : 1}>
          {pane.workspaceLabel} · {kind}
        </Text>
      </Pressable>

      {prompt ? (
        <>
          <Text style={styles.question}>{prompt.question}</Text>
          <PromptContext context={prompt.context} />
          {stale && <UiText style={styles.stale}>This question is as it was last seen. Answers are available when the computer reconnects.</UiText>}
          {prompt.options.map((option, i) => {
            const isArmed = armed === option.index;
            const lit = isArmed || (armed === null && !!option.selected);
            // Shown without the terminal's key hints; `choose` sends the parser's own label.
            const label = labels[i];
            return (
              <Pressable
                accessibilityRole="button"
                // The option's words, not its glyphs: VoiceOver used to read
                // the cursor mark and the blank beside it ("❯, 1., Red").
                // Where the terminal's cursor sits is a state, said as one.
                accessibilityLabel={[prompt.answer === "digit" ? `${option.index}. ${label}` : label, option.detail]
                  .filter(Boolean).join(", ")}
                accessibilityState={{ selected: lit, disabled: armed !== null || stale }}
                key={option.index}
                style={[styles.choice, isArmed && styles.choiceArmed, stale && styles.choiceStale]}
                disabled={armed !== null || stale}
                onPress={() => choose(option)}
              >
                <UiText style={styles.cursor}>{lit ? "❯" : " "}</UiText>
                {/* The digit is what the terminal takes; a cursor menu has none. */}
                {prompt.answer === "digit" && <Text style={styles.choiceIndex}>{option.index}.</Text>}
                <View style={styles.choiceBody}>
                  <Text style={styles.choiceLabel}>{label}</Text>
                  {option.detail && <Text style={styles.choiceDetail}>{option.detail}</Text>}
                </View>
              </Pressable>
            );
          })}
          {failure && <UiText style={styles.failure} accessibilityRole="alert">{failure}</UiText>}
        </>
      ) : answered ? (
        // Between an answer and the snapshot that shows the agent moving on,
        // the pane still says blocked. A card with only two states called it
        // "needs a typed reply" there (pre-release bug hunt).
        <Pressable accessibilityRole="button" onPress={onOpen}>
          <UiText style={styles.question} accessibilityLiveRegion="polite">
            {answered.outcome === "sent"
              ? "Answer sent — waiting for the agent…"
              : "That question had already closed, so nothing was sent. Waiting for the agent’s next step…"}
          </UiText>
        </Pressable>
      ) : (
        <Pressable accessibilityRole="button" onPress={onOpen}>
          <UiText style={styles.question}>This one needs a typed reply. Open it →</UiText>
        </Pressable>
      )}
    </View>
  );
}

const Centered = ({ children }: { children: React.ReactNode }) => (
  <View style={styles.centered}>
    <Text style={styles.dim}>{children}</Text>
  </View>
);

const styles = StyleSheet.create({
  inboxHeading: { paddingHorizontal: 20, paddingVertical: 12, gap: 6 },
  inboxTitle: { color: theme.fg, fontSize: 22, fontWeight: "600" },
  inboxLabel: { color: theme.dim, fontSize: 12, paddingHorizontal: 20, paddingTop: 12 },
  reviewed: { alignSelf: "flex-end", paddingHorizontal: 20, minHeight: 44, justifyContent: "center" },
  reviewedText: { color: theme.mint, fontSize: 14, fontWeight: "600" },
  screen: { flex: 1, backgroundColor: theme.void },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 32 },
  dim: { color: theme.dim, textAlign: "center" },

  status: { flexDirection: "row", alignItems: "center", gap: 10 },
  notice: {
    color: theme.dim,
    fontSize: 12,
    lineHeight: 18,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: theme.surface,
  },

  groupLabel: {
    color: theme.dim,
    fontSize: 11,
    letterSpacing: 1.2,
    paddingHorizontal: 16,
    paddingTop: 22,
    paddingBottom: 8,
  },

  filters: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
  // Clears the floating native tab bar so the last agent is tappable, not under it.
  listContent: { paddingBottom: 96 },
  search: { marginHorizontal: 16, marginBottom: 12, flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: theme.lineBright, borderRadius: 10, backgroundColor: theme.surface },
  searchInput: { flex: 1, minWidth: 0, minHeight: 44, padding: 12, color: theme.fg, fontSize: 15 },
  searchClear: { minWidth: 44, minHeight: 44, justifyContent: "center", paddingHorizontal: 12 },
  newAgent: {
    marginHorizontal: 16,
    marginVertical: 8,
    minHeight: 44,
    borderWidth: 1,
    borderColor: theme.peach,
    backgroundColor: theme.peach,
    borderRadius: 10,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
  newAgentText: { color: theme.void, fontSize: 14, fontWeight: "500" },
  filter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minWidth: 44,
    borderWidth: 1,
    borderColor: theme.line,
    borderRadius: 999,
    paddingHorizontal: 14,
    minHeight: 44,
    justifyContent: "center",
    backgroundColor: theme.surface,
  },
  filterOn: { backgroundColor: theme.raised, borderColor: theme.lineBright },
  filterText: { color: theme.dim, fontSize: 14 },
  filterTextOn: { color: theme.fg, fontWeight: "600" },

  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.line,
    // Past the avatar, so the circles read as one column.
    marginLeft: 70,
  },
  sheetLayer: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, justifyContent: "flex-end" },
  // Floating above the native tab bar rather than sliding under it — the
  // first cut pinned to the bottom edge and buried Cancel beneath the tabs.
  sheetBack: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.55)" },
  sheetCard: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.line,
    borderRadius: 16,
    borderCurve: "continuous",
    marginHorizontal: 10,
    marginBottom: 104,
    padding: 16,
    gap: 4,
  },
  sheetTitle: { color: theme.dim, fontSize: 12, marginBottom: 8 },
  sheetItem: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 48 },
  sheetItemText: { color: theme.fg, fontSize: 16 },
  actions: { flexDirection: "row" },
  action: {
    width: 76,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    backgroundColor: theme.raised,
  },
  actionText: { color: theme.dim, fontSize: 12 },

  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 15, backgroundColor: theme.void },
  rowBody: { flex: 1, gap: 2 },
  rowLine: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  rowTitle: { color: theme.fg, fontSize: 15, fontWeight: "600", flex: 1 },
  rowSaid: { color: theme.dim, fontSize: 13, flex: 1 },
  rowTyping: { color: theme.working, fontStyle: "italic" },
  rowMeta: { color: theme.dim, fontFamily: theme.mono, fontSize: 12 },
  rowStatus: { fontSize: 12, letterSpacing: 0.5 },
  rowTime: { color: theme.dim, fontSize: 12, flexShrink: 0 },
  rowQuiet: { fontStyle: "italic", opacity: 0.8 },
  reviewAll: { alignSelf: "flex-end", paddingHorizontal: 20, minHeight: 44, justifyContent: "center" },

  blocked: {
    margin: 16,
    borderWidth: 1,
    borderColor: theme.peach,
    borderRadius: 10, borderCurve: "continuous",
    backgroundColor: theme.surface,
    padding: 16,
  },
  badge: { color: theme.peach, fontSize: 11, fontWeight: "600" },
  where: { color: theme.fg, fontSize: 17, fontWeight: "600", marginTop: 8 },
  task: { color: theme.dim, fontFamily: theme.mono, fontSize: 12, marginTop: 2 },
  failure: { color: theme.rose, fontSize: 13, lineHeight: 18, marginTop: 8 },
  question: {
    color: theme.fg,
    fontSize: 15,
    lineHeight: 21,
    marginTop: 14,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: theme.line,
  },

  choice: { flexDirection: "row", alignItems: "flex-start", gap: 8, minHeight: 44, paddingVertical: 11, paddingHorizontal: 4, borderRadius: 6, borderCurve: "continuous" },
  choiceArmed: { backgroundColor: theme.raised },
  choiceStale: { opacity: 0.45 },
  stale: { color: theme.dim, fontSize: 13, lineHeight: 18, marginBottom: 6 },
  // A minimum, not a width, as on the pane's card: a fixed 12pt box cut the
  // glyph to a sliver at AX5.
  cursor: { color: theme.peach, fontFamily: theme.mono, fontSize: 14, minWidth: 12 },
  choiceIndex: { color: theme.dim, fontSize: 14 },
  choiceBody: { flex: 1 },
  choiceLabel: { color: theme.fg, fontSize: 16, lineHeight: 22 },
  /** The agent's own explanation of a choice, where it wrote one. */
  choiceDetail: { color: theme.dim, fontSize: 12, lineHeight: 17, marginTop: 3 },
});
