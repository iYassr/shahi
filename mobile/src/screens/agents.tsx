/**
 * The Agents screen: which agent needs you, and what it is asking.
 *
 * Deliberately the same information architecture as the web client — blocked
 * agents pinned above everything, everything else collapsed to one line —
 * because that decision was the point of the product, not an artefact of the
 * platform. What differs is only how it is drawn.
 */
import { memo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { RectButton } from "react-native-gesture-handler";
import ReanimatedSwipeable from "react-native-gesture-handler/ReanimatedSwipeable";
import { Stack } from "expo-router";
import type { DashboardPane, ParsedPrompt } from "@shahi/shared";
import { api } from "@/lib/api";
import { landed, refused } from "@/lib/feel";
import { openScreen } from "@/lib/navigate";
import { useSession } from "@/lib/session";
import { theme } from "@/lib/theme";
import { Icon } from "@/components/icons";
import { Avatar } from "@/components/avatar";

export function Agents({ onOpenPane }: { onOpenPane: (paneId: string) => void }) {
  const { session, prompts, link, error, clearPrompt, pins, togglePin, server } = useSession();
  const [failure, setFailure] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  /** The row a long-press opened actions for. */
  const [acting, setActing] = useState<DashboardPane | null>(null);

  async function answer(paneId: string, index: number) {
    try {
      await api.answerPrompt(paneId, index);
      landed();
      clearPrompt(paneId);
    } catch (e) {
      refused();
      setFailure((e as Error).message);
    }
  }

  if (error ?? failure) return <Centered>{error ?? failure}</Centered>;
  if (!session) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={theme.peach} />
        <Text style={styles.dim}>Connecting to herdr…</Text>
      </View>
    );
  }

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
  const chips: { id: string; label: string }[] = [
    { id: "all", label: "All" },
    ...(waiting > 0 ? [{ id: "waiting", label: `Waiting ${waiting}` }] : []),
    ...kinds.map((k) => ({ id: `kind:${k}`, label: k })),
    ...(shells.length > 0 ? [{ id: "shells", label: "Shells" }] : []),
  ];

  // A chip can vanish under its selection — the last codex exits, the waiting
  // agent gets its answer. Falling back to All beats an empty screen filtered
  // by a control that is no longer on it.
  const active = chips.some((c) => c.id === filter) ? filter : "all";
  const shown =
    active === "all"
      ? agents
      : active === "waiting"
        ? agents.filter((p) => p.status === "blocked")
        : active === "shells"
          ? shells
          : agents.filter((p) => `kind:${p.agent}` === active);
  const blocked = shown.filter((p) => p.status === "blocked");
  // Pinned first, and stably: within each half the server's order holds.
  // Blocked panes are deliberately not pin-sorted — the card is already the
  // top of the screen, and a pin must not compete with a question.
  const rest = [
    ...shown.filter((p) => p.status !== "blocked" && pins.has(p.paneId)),
    ...shown.filter((p) => p.status !== "blocked" && !pins.has(p.paneId)),
  ];

  return (
    <View style={styles.screen}>
      {/* Just the server and whether it is talking — the waiting count was
          the card's job said twice, and the bell now lives in Settings. */}
      <Stack.Screen
        options={{
          headerRight: () => (
            <View style={styles.status}>
              <Text style={[styles.link, { color: theme.dim }]} numberOfLines={1}>
                {server.replace(/^https?:\/\//, "")}
              </Text>
              <Text style={[styles.link, { color: link === "live" ? theme.mint : theme.dim }]}>
                {link === "live" ? "LIVE" : link === "lost" ? "OFFLINE" : "…"}
              </Text>
            </View>
          ),
        }}
      />
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        data={rest}
        keyExtractor={(p) => p.paneId}
        ListHeaderComponent={
          <>
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
                  key={chip.id}
                  style={[styles.filter, chip.id === active && styles.filterOn]}
                  onPress={() => setFilter(chip.id)}
                >
                  <Text style={[styles.filterText, chip.id === active && styles.filterTextOn]}>
                    {chip.label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            {blocked.map((pane) => (
              <BlockedCard
                key={pane.paneId}
                pane={pane}
                prompt={prompts[pane.paneId]}
                onAnswer={(i) => void answer(pane.paneId, i)}
                onOpen={() => onOpenPane(pane.paneId)}
              />
            ))}
            {rest.length > 0 && (
              <Text style={styles.groupLabel}>
                {blocked.length > 0
                  ? "EVERYTHING ELSE"
                  : `${rest.length} ${active === "shells" ? "SHELLS" : "AGENTS"}`}
              </Text>
            )}
          </>
        }
        renderItem={({ item }) => (
          <Row
            pane={item}
            pinned={pins.has(item.paneId)}
            onPress={onOpenPane}
            onPin={togglePin}
            onActions={setActing}
          />
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
            <Centered>{active === "all" ? "No agents running." : "Nothing here right now."}</Centered>
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
          <Pressable style={styles.sheetBack} onPress={() => setActing(null)} />
          <View style={styles.sheetCard}>
              <Text style={styles.sheetTitle} numberOfLines={1}>
                {acting.title ?? acting.paneId}
              </Text>
              <Pressable
                style={styles.sheetItem}
                onPress={() => {
                  togglePin(acting.paneId);
                  setActing(null);
                }}
              >
                <Icon name={pins.has(acting.paneId) ? "pin-off" : "pin"} color={theme.peach} size={16} />
                <Text style={styles.sheetItemText}>
                  {pins.has(acting.paneId) ? "Unpin" : "Pin"}
                </Text>
              </Pressable>
              <Pressable
                style={styles.sheetItem}
                onPress={() => {
                  setActing(null);
                  openScreen(acting.paneId);
                }}
              >
                <Icon name="terminal" color={theme.mint} size={16} />
                <Text style={styles.sheetItemText}>Open screen</Text>
              </Pressable>
              <Pressable style={styles.sheetItem} onPress={() => setActing(null)}>
                <Text style={[styles.sheetItemText, { color: theme.dim }]}>Cancel</Text>
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
  onPin,
  onActions,
}: {
  pane: DashboardPane;
  pinned: boolean;
  // Stable callbacks that take the pane, so memo actually holds: inline
  // closures would give every row a new identity on each list render.
  onPress: (paneId: string) => void;
  onPin: (paneId: string) => void;
  onActions: (pane: DashboardPane) => void;
}) {
  const row = (
      <Pressable
        style={styles.row}
        // The pinned state rides in the row's own id: children of a pressable
        // flatten into one accessibility element, so a marker inside it is
        // invisible to the test driver — the row's id is not.
        testID={`row-${pane.paneId}${pinned ? "-pinned" : ""}`}
        onPress={() => onPress(pane.paneId)}
        // The same actions as the swipe, reachable without knowing the swipe
        // exists.
        onLongPress={() => onActions(pane)}
      >
        <Avatar pane={pane} />
        <View style={styles.rowBody}>
          <View style={styles.rowLine}>
            <Text style={styles.rowTitle} numberOfLines={1}>
              {pane.title ?? pane.paneId}
            </Text>
            {pinned && <Icon name="pin" color={theme.dim} size={12} />}
            {/* "idle" is the resting state of most of a real herd; saying it
                twenty-six times is what made the list feel crowded. Only a
                state that asks something of you gets a word. */}
            {pane.status !== "idle" && (
              <Text style={[styles.rowStatus, { color: statusColor(pane.status) }]}>
                {pane.status}
              </Text>
            )}
            <Text style={styles.rowMeta}>{pane.workspaceLabel}</Text>
          </View>
          {/* A quiet agent's second line is where it is working, not a
              "No conversation yet." filler — the path answers "which one is
              this" while saying nothing twenty-six times was the crowding. */}
          {(pane.activity || pane.preview || pane.cwd) && (
            <View style={styles.rowLine}>
              {pane.activity ? (
                // What "typing…" means when the other party is an agent.
                <Text style={[styles.rowSaid, styles.rowTyping]} numberOfLines={1}>
                  {pane.activity.verb}… {pane.activity.elapsed}
                </Text>
              ) : (
                <Text style={styles.rowSaid} numberOfLines={1}>
                  {pane.preview ?? pane.cwd}
                </Text>
              )}
            </View>
          )}
        </View>
      </Pressable>
  );
  return (
    <ReanimatedSwipeable
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
            <Text style={styles.actionText}>{pinned ? "Unpin" : "Pin"}</Text>
          </RectButton>
          <RectButton
            style={styles.action}
            onPress={() => {
              swipeable_.close();
              openScreen(pane.paneId);
            }}
          >
            <Icon name="terminal" color={theme.mint} />
            <Text style={styles.actionText}>Screen</Text>
          </RectButton>
        </View>
      )}
    >
      {row}
    </ReanimatedSwipeable>
  );
});

/**
 * The answer list, rebuilt from the terminal's own — same numbering, same
 * cursor, sized for a thumb.
 */
function BlockedCard({
  pane,
  prompt,
  onAnswer,
  onOpen,
}: {
  pane: DashboardPane;
  prompt: ParsedPrompt | undefined;
  onAnswer: (index: number) => void;
  onOpen: () => void;
}) {
  const [armed, setArmed] = useState<number | null>(null);

  return (
    <View style={styles.blocked}>
      <Pressable onPress={onOpen}>
        <Text style={styles.badge}>● WAITING ON YOU</Text>
        <Text style={styles.where}>{pane.workspaceLabel}</Text>
        <Text style={styles.task} numberOfLines={1}>
          {pane.agent ?? "agent"} · {pane.paneId} · {pane.title ?? "untitled"}
        </Text>
      </Pressable>

      {prompt ? (
        <>
          <Text style={styles.question}>{prompt.question}</Text>
          {/* What the agent said above the question — the command it wants to
              run, usually. Without it a codex approval reads as a bare "Allow?"
              with nothing to judge. */}
          {prompt.context && prompt.context.length > 0 && (
            <View style={styles.context}>
              {prompt.context.map((line, i) => (
                <Text style={styles.contextLine} key={i}>
                  {line}
                </Text>
              ))}
            </View>
          )}
          {prompt.options.map((option) => {
            const isArmed = armed === option.index;
            return (
              <Pressable
                key={option.index}
                style={[styles.choice, isArmed && styles.choiceArmed]}
                disabled={armed !== null}
                onPress={() => {
                  setArmed(option.index);
                  onAnswer(option.index);
                }}
              >
                <Text style={styles.cursor}>
                  {isArmed || (armed === null && option.selected) ? "❯" : " "}
                </Text>
                <Text style={styles.choiceIndex}>{option.index}.</Text>
                <View style={styles.choiceBody}>
                  <Text style={styles.choiceLabel}>{option.label}</Text>
                  {option.detail && <Text style={styles.choiceDetail}>{option.detail}</Text>}
                </View>
              </Pressable>
            );
          })}
        </>
      ) : (
        <Pressable onPress={onOpen}>
          <Text style={styles.question}>This one needs a typed reply. Open it →</Text>
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

const statusColor = (status: string) =>
  status === "working" ? theme.mint : status === "blocked" ? theme.peach : theme.dim;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.void },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 32 },
  dim: { color: theme.dim, textAlign: "center" },

  status: { flexDirection: "row", alignItems: "center", gap: 10 },
  link: { fontFamily: theme.mono, fontSize: 11, letterSpacing: 1 },
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
    fontFamily: theme.mono,
    fontSize: 11,
    letterSpacing: 1.2,
    paddingHorizontal: 16,
    paddingTop: 22,
    paddingBottom: 8,
  },

  filters: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
  filter: {
    borderWidth: 1,
    borderColor: theme.line,
    borderRadius: 999,
    paddingHorizontal: 14,
    minHeight: 34,
    justifyContent: "center",
    backgroundColor: theme.surface,
  },
  filterOn: { backgroundColor: theme.raised, borderColor: theme.peach },
  filterText: { color: theme.dim, fontFamily: theme.mono, fontSize: 12 },
  filterTextOn: { color: theme.peach },

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
  sheetTitle: { color: theme.dim, fontFamily: theme.mono, fontSize: 12, marginBottom: 8 },
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
  actionText: { color: theme.dim, fontFamily: theme.mono, fontSize: 10 },

  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 15, backgroundColor: theme.void },
  rowBody: { flex: 1, gap: 2 },
  rowLine: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  rowTitle: { color: theme.fg, fontSize: 15, fontWeight: "600", flex: 1 },
  rowSaid: { color: theme.dim, fontSize: 13, flex: 1 },
  rowTyping: { color: theme.mint, fontStyle: "italic" },
  rowMeta: { color: theme.dim, fontFamily: theme.mono, fontSize: 10 },
  rowStatus: { fontFamily: theme.mono, fontSize: 10, letterSpacing: 0.5 },

  blocked: {
    margin: 16,
    borderWidth: 1,
    borderColor: theme.peach,
    borderRadius: 10, borderCurve: "continuous",
    backgroundColor: theme.surface,
    padding: 16,
  },
  badge: { color: theme.peach, fontFamily: theme.mono, fontSize: 11, letterSpacing: 1.4, fontWeight: "600" },
  where: { color: theme.fg, fontSize: 17, fontWeight: "600", marginTop: 8 },
  task: { color: theme.dim, fontFamily: theme.mono, fontSize: 12, marginTop: 2 },
  context: { borderLeftWidth: 1, borderLeftColor: theme.line, paddingLeft: 10, marginBottom: 12, gap: 4 },
  contextLine: { color: theme.dim, fontFamily: theme.mono, fontSize: 12, lineHeight: 17 },
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
  cursor: { color: theme.peach, fontFamily: theme.mono, fontSize: 14, width: 12 },
  choiceIndex: { color: theme.dim, fontFamily: theme.mono, fontSize: 14 },
  choiceBody: { flex: 1 },
  choiceLabel: { color: theme.fg, fontFamily: theme.mono, fontSize: 14, lineHeight: 19 },
  /** The agent's own explanation of a choice, where it wrote one. */
  choiceDetail: { color: theme.dim, fontSize: 12, lineHeight: 17, marginTop: 3 },
});
