import { plainHeaderRight } from "@/lib/header-controls";
import { ComputerSwitcher } from "@/components/computer-switcher";
import { LinkBadge } from "@/components/link-badge";
import { SafeAreaView } from "react-native-safe-area-context";
import { ConnectionHealth } from "@/components/connection-health";
import { randomUUID } from "expo-crypto";
/**
 * Spaces: where things live, and where new work goes.
 *
 * The other half of herdr's own sidebar split. Agents is triage; this is
 * structure — and it is the only place plain shells are reachable, since the
 * Agents view filters them out and they are roughly half the panes in a real
 * session.
 *
 * Navigation is routes, not state. Agent creation is a scrollable screen so
 * installed-agent choices and permission modes fit at every text size; the
 * smaller new-space form remains a sheet.
 */
import { memo, useCallback, useEffect, useMemo, useState, useRef } from "react";
import { BackHandler, FlatList, ScrollView, Pressable, StyleSheet, TextInput, View } from "react-native";
import { Text, useLargeText } from "@/components/text";
import { useRememberedScroll } from "@/lib/scroll-memory";
import { router, Stack } from "expo-router";
import { modesFor, type DashboardPane, type Session, type Space } from "@shahi/shared";
import { landed, refused } from "@/lib/feel";
import { openPane, openSpace } from "@/lib/navigate";
import { useSession } from "@/lib/session";
import { theme, statusColor } from "@/lib/theme";
import { agentLabel } from "@shahi/shared";
import { Avatar } from "@/components/avatar";
import { conversationLabel, paneTitle } from "@/components/conversation-label";
import { Icon } from "@/components/icons";

export function Spaces({ session }: { session: Session | null }) {
  // Same header furniture as the Agents tab — the two lists are siblings and
  // should read as one app, not two designs.
  const { activeComputerId, api } = useSession();
  // Above the `!session` return below: hooks cannot be called conditionally.
  const spaceScroll = useRememberedScroll("spaces", () => session?.workspaces ?? [], (w) => w.workspaceId, api);
  const header = (
    <Stack.Screen
      options={{
        ...plainHeaderRight(
          <View style={styles.status}>
            <ComputerSwitcher />
            <LinkBadge />
          </View>
        ),
      }}
    />
  );
  if (!session) return <>{header}<Centered>Connecting…</Centered></>;

  return (
    <View style={styles.screen}>
      {header}
      <FlatList
        {...spaceScroll}
        contentInsetAdjustmentBehavior="automatic"
        data={session.workspaces}
        keyExtractor={(w) => w.workspaceId}
        ListHeaderComponent={
          <><ConnectionHealth />{session.workspaces.length > 0 ? (
            <Text style={styles.groupLabel}>
              {session.workspaces.length} SPACE{session.workspaces.length === 1 ? "" : "S"}
            </Text>
          ) : null}</>
        }
        // The same chat-list grammar as the Agents tab. The avatar is the
        // space's number — herdr's own vocabulary for workspaces, and what a
        // keyboard user would press to reach it in the TUI.
        renderItem={({ item, index }) => {
          const blocked = session.panes.filter(
            (p) => p.workspaceId === item.workspaceId && p.status === "blocked",
          ).length;
          return (
            <Pressable
              accessibilityRole="button"
              style={styles.space}
              testID={`space-${item.workspaceId}`}
              onPress={() => openSpace(item.workspaceId, activeComputerId)}
            >
              <View style={styles.avatar}>
                <Icon name="folder" size={42} color={statusColor(item.status)} />
                <Text
                  style={[styles.avatarNumber, { color: statusColor(item.status) }]}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  maxFontSizeMultiplier={1.2}
                >
                  {index + 1}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.spaceName}>{item.label}</Text>
                <Text style={styles.spaceMeta} numberOfLines={1}>
                  {item.cwd ?? item.workspaceId} · {item.tabCount} tab
                  {item.tabCount === 1 ? "" : "s"} · {item.paneCount} pane
                  {item.paneCount === 1 ? "" : "s"}
                </Text>
              </View>
              {blocked > 0 && <Text style={styles.badge}>{blocked}</Text>}
            </Pressable>
          );
        }}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListFooterComponent={
          <Pressable accessibilityRole="button" style={styles.action} onPress={() => router.push("/new-space")}>
            <Text style={styles.actionText}>+ New space</Text>
          </Pressable>
        }
      />
    </View>
  );
}

export function SpaceDetail({ space, session }: { space: Space; session: Session }) {
  const { activeComputerId, api } = useSession();
  // Stable per computer, so the memoised rows below keep their identity.
  const open = useCallback((paneId: string) => openPane(paneId, activeComputerId), [activeComputerId]);
  const tabs = useMemo(
    () => session.tabs.filter((t) => t.workspaceId === space.workspaceId),
    [session, space],
  );
  const tabScroll = useRememberedScroll(`space:${space.workspaceId}`, () => tabs, (t) => t.tabId, api);

  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View style={styles.headTitle}>
              <Text style={styles.title}>{space.label}</Text>
              <Text style={styles.spaceMeta}>{space.cwd ?? space.workspaceId}</Text>
            </View>
          ),
        }}
      />

      <FlatList
        {...tabScroll}
        contentInsetAdjustmentBehavior="automatic"
        data={tabs}
        keyExtractor={(t) => t.tabId}
        renderItem={({ item }) => {
          const panes = session.panes.filter((p) => p.tabId === item.tabId);
          return (
            <View>
              <Text style={styles.groupLabel}>
                {/^\d+$/.test(item.label) ? `TAB ${item.label}` : item.label.toUpperCase()}
              </Text>
              {panes.map((pane, i) => (
                <View key={pane.paneId}>
                  {i > 0 && <View style={styles.separator} />}
                  <PaneRow pane={pane} onPress={open} />
                </View>
              ))}
            </View>
          );
        }}
        ListFooterComponent={
          <Pressable
            accessibilityRole="button"
            testID="space-new-agent"
            style={[styles.action, styles.actionPrimary]}
            onPress={() =>
              router.push({
                pathname: "/new-agent",
                params: { workspaceId: space.workspaceId, ...(activeComputerId && { computer: activeComputerId }) },
              })
            }
          >
            <Text style={styles.actionPrimaryText}>+ New agent</Text>
          </Pressable>
        }
      />
    </View>
  );
}

/** The same chat-list grammar as the Agents tab, keeping the tab grouping. */
const PaneRow = memo(function PaneRow({
  pane,
  onPress,
}: {
  pane: DashboardPane;
  // Stable callback taking the id, so memo holds across list re-renders.
  onPress: (paneId: string) => void;
}) {
  // The Agents row's large-text treatment. Without it the status and agent
  // label, which cannot shrink, took the whole width at accessibility sizes
  // and the title — the only thing that names the conversation — got none
  // (September 2026 review).
  const largeText = useLargeText();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={conversationLabel(pane)} style={styles.row} onPress={() => onPress(pane.paneId)}>
      <Avatar pane={pane} />
      <View style={styles.rowBody}>
        <View style={[styles.rowLine, largeText && { flexDirection: "column", alignItems: "stretch" }]}>
          <Text style={[styles.rowTitle, largeText && { flex: 0 }]} numberOfLines={largeText ? 2 : 1}>
            {pane.isAgent || pane.title?.trim() ? paneTitle(pane) : "shell"}
          </Text>
          {/* Same quieting as the Agents rows: idle says nothing, and the
              second line only exists when there is something to preview. */}
          <View style={{ flexDirection: "row", gap: 8, flexShrink: 1, maxWidth: largeText ? "100%" : "50%" }}>
            {pane.status !== "idle" && (
              <Text style={[styles.rowStatus, { color: statusColor(pane.status) }]}>
                {pane.status}
              </Text>
            )}
            <Text style={[styles.rowMeta, { flexShrink: 1 }]} numberOfLines={1}>{pane.agent ? agentLabel(pane.agent) : pane.paneId}</Text>
          </View>
        </View>
        {(pane.activity || pane.preview || pane.cwd) && (
          <View style={styles.rowLine}>
            {pane.activity ? (
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
});

export function NewSpace({ session, onCreated }: { session: Session; onCreated: () => void }) {
  const { api } = useSession();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A new space usually sits beside an existing one.
  const suggestions = useMemo(
    () => [...new Set(session.workspaces.map((w) => w.cwdPath).filter((p): p is string => !!p))],
    [session],
  );
  const [cwd, setCwd] = useState(suggestions[0] ?? "");

  async function create() {
    setBusy(true);
    try {
      // Absolute only: herdr does not expand `~` and does not reject it either,
      // it silently uses $HOME.
      await api.createWorkspace({ label: name.trim() || "new space", cwd: cwd.trim() });
      onCreated();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <SheetBody title="New space">
      <Text style={styles.label}>NAME</Text>
      <TextInput
        style={styles.input}
        value={name}
        onChangeText={setName}
        placeholder="what you are working on"
        placeholderTextColor={theme.dim}
        accessibilityLabel="Space name"
      />
      <Text style={styles.label}>FOLDER</Text>
      <TextInput
        style={styles.input}
        value={cwd}
        onChangeText={setCwd}
        autoCapitalize="none"
        autoCorrect={false}
        testID="new-space-folder"
        placeholder="/home/you/project"
        placeholderTextColor={theme.dim}
        accessibilityLabel="Space folder"
      />
      {/* A wrapping row like the agent-kind chips: a FlatList cannot size
          itself inside this fit-to-contents sheet, and the chips floated up
          over the title. Existing paths are shortcuts; the editable field is
          what makes the first space on a new box possible at all. */}
      <View style={styles.kinds}>
        {suggestions.map((item) => (
          <Pressable accessibilityRole="button" accessibilityState={{ selected: item === cwd }} key={item} style={[styles.chip, item === cwd && styles.chipOn]} onPress={() => setCwd(item)}>
            <Text style={[styles.chipText, item === cwd && styles.chipTextOn]} numberOfLines={1}>{item}</Text>
          </Pressable>
        ))}
      </View>
      {error && <Text style={styles.err}>{error}</Text>}
      <Pressable accessibilityRole="button" style={[styles.go, (busy || !cwd.trim()) && styles.goOff]} disabled={busy || !cwd.trim()} onPress={() => void create()} testID="create-space">
        <Text style={styles.goText}>{busy ? "Creating…" : "Create space"}</Text>
      </Pressable>
    </SheetBody>
  );
}

/**
 * The first step of "new agent" when it starts from the Agents tab rather
 * than from inside a space: which space. The form under it is the same one
 * a space's own "+ New agent" opens — the agent is the thing being made, and
 * where it lives is a choice, not a place you have to navigate to first.
 */
export function PickSpace({ session, onPick }: { session: Session; onPick: (space: Space) => void }) {
  return (
    <SheetBody title="Choose a space" fullScreen>
      {session.workspaces.length === 0 ? (
        <Pressable accessibilityRole="button" style={styles.action} onPress={() => router.replace("/new-space")}>
          <Text style={styles.actionText}>No spaces yet — make one first</Text>
        </Pressable>
      ) : (
        <View>
          {session.workspaces.map((item, index) => (
            <Pressable accessibilityRole="button" key={item.workspaceId} style={styles.space} onPress={() => onPick(item)} testID={`pick-${item.workspaceId}`}>
              <View style={[styles.avatar, { borderColor: statusColor(item.status) }]}>
                <Text style={[styles.avatarNumber, { color: statusColor(item.status) }]}>{index + 1}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.spaceName}>{item.label}</Text>
                <Text style={styles.spaceMeta} numberOfLines={1}>{item.cwd ?? item.workspaceId}</Text>
              </View>
            </Pressable>
          ))}
        </View>
      )}
    </SheetBody>
  );
}

export function NewAgent({ space, onStarted }: { space: Space; onStarted: (paneId: string) => void }) {
  const { api } = useSession();
  const attempt = useRef<{ key: string; id: string } | null>(null);
  const starting = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [kinds, setKinds] = useState<string[]>([]);
  const [kind, setKind] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "starting">("idle");
  const [error, setError] = useState<string | null>(null);

  /*
   * How much the agent may do without asking.
   *
   * Every agent has this setting and every one spells it differently, so the
   * choice belongs here rather than three prompts later when it stops over a
   * `mkdir`. On a phone that matters more than on a desktop: answering
   * permission prompts one at a time through a dashboard is the friction this
   * app exists to remove. `shared/modes.ts` holds the flags, checked against
   * each agent's `--help` on the machine that runs them, and the server
   * resolves the id — nothing here decides what runs on the far end.
   */
  const modes = modesFor(kind);
  const [mode, setMode] = useState<string | null>(null);
  // Reset whenever the agent changes: modes do not carry across kinds, and a
  // stale id would silently resolve to no flags at all.
  function chooseKind(value: string) {
    setKind(value);
    setMode(modesFor(value)[0]?.id ?? null);
  }
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);
    void api.agents().then((d) => {
      if (!active) return;
      const available = [...new Set(d.agents.map((a) => a.kind))];
      setKinds(available);
      if (available[0]) chooseKind(available[0]);
      else { setKind(null); setMode(null); }
    }).catch((e) => {
      if (active) setLoadError(e instanceof Error ? e.message : "Could not load agents.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, loadAttempt]);

  async function start() {
    if (!kind || loading || loadError || starting.current) return;
    starting.current = true;
    const key = JSON.stringify([space.workspaceId, space.cwdPath, kind, mode]);
    if (attempt.current?.key !== key) attempt.current = { key, id: randomUUID() };
    setError(null);
    setPhase("starting");
    try {
      // One call: the server makes the tab, waits for its shell, then starts the
      // agent. herdr blocks until the agent reports readiness, which on a cold
      // start is genuinely slow.
      const { paneId } = await api.startAgent({
        clientRequestId: attempt.current.id,
        workspaceId: space.workspaceId,
        workspaceLabel: space.label,
        cwd: space.cwdPath,
        label: null,
        kind,
        name: `${kind.slice(0, 15)}-${attempt.current.id.replace(/-/g, "").slice(0, 16)}`,
        mode,
      });
      if (!mounted.current) return;
      landed();
      onStarted(paneId);
    } catch (e) {
      if (!mounted.current) return;
      refused();
      setError((e as Error).message);
      setPhase("idle");
    } finally {
      starting.current = false;
    }
  }

  const busy = phase !== "idle";
  useEffect(() => {
    if (!busy) return;
    // Leaving during startup loses the operation ID and permits a second
    // start while the first is still creating its agent on the computer.
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => true);
    return () => subscription.remove();
  }, [busy]);
  return (
    <SheetBody title={`New agent in ${space.label}`} fullScreen busy={busy}>
      <Stack.Screen options={{ gestureEnabled: !busy }} />
      {loading && <Text style={styles.note}>Finding your agents…</Text>}
      {loadError && <><Text style={styles.err}>{loadError}</Text><Pressable accessibilityRole="button" testID="retry-agent-list" onPress={() => setLoadAttempt((n) => n + 1)}><Text style={styles.actionText}>Try again</Text></Pressable></>}
      {!loading && !loadError && kinds.length === 0 && <Text style={styles.note}>No agents are installed on this computer yet.</Text>}
      <Text style={styles.label}>AGENT</Text>
      <View style={styles.kinds}>
        {kinds.map((k) => (
          <Pressable accessibilityRole="button" accessibilityState={{ selected: k === kind }} key={k} style={[styles.chip, k === kind && styles.chipOn]} onPress={() => chooseKind(k)} testID={`agent-kind-${k}`} disabled={busy || loading}>
            <Text style={[styles.chipText, k === kind && styles.chipTextOn]}>{agentLabel(k)}</Text>
          </Pressable>
        ))}
      </View>
      {modes.length > 0 && (
        <>
          <Text style={styles.label}>PERMISSIONS</Text>
          <View style={styles.modes}>
            {modes.map((option) => (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: option.id === mode }}
                key={option.id}
                testID={`agent-mode-${option.id}`}
                style={[
                  styles.mode,
                  option.id === mode && styles.modeOn,
                  option.unsafe && styles.modeUnsafe,
                ]}
                onPress={() => setMode(option.id)}
                disabled={busy}
              >
                <Text style={[styles.modeLabel, option.id === mode && styles.modeLabelOn]}>
                  {option.label}
                </Text>
                {option.unsafe && <Text style={{ color: theme.rose, fontSize: 13, fontWeight: "600" }}>No approval before changes</Text>}
                <Text style={styles.modeWhy}>{option.description}</Text>
              </Pressable>
            ))}
          </View>
        </>
      )}
      {error && <Text style={styles.err}>{error}</Text>}
      <Pressable accessibilityRole="button" style={[styles.go, (busy || !kind) && styles.goOff]} disabled={busy || !kind || loading || !!loadError} testID="start-agent" onPress={() => void start()}>
        <Text style={styles.goText}>
          {phase === "starting" ? `Waiting for ${kind ? agentLabel(kind) : "agent"}…` : `Start ${kind ? agentLabel(kind) : "agent"}`}
        </Text>
      </Pressable>
      <Text style={styles.note}>A cold start can take half a minute.</Text>
    </SheetBody>
  );
}

/**
 * Shared form body: a title row, then the form.
 *
 * Agent selection changes height between steps and can contain many choices.
 * A full screen with one scroll container avoids native fit-to-content sheet
 * measurement races and keeps the Start button reachable at large text sizes.
 */
function SheetBody({ title, children, fullScreen = false, busy = false }: { title: string; children: React.ReactNode; fullScreen?: boolean; busy?: boolean }) {
  const content = (
    <View style={styles.sheet}>
      {/* react-native-screens requires a non-collapsible header beside a
          ScrollView/FlatList in a formSheet. When React flattened this View,
          iOS counted the title and Close as separate native children and laid
          the first workspace underneath them. */}
      <View style={styles.sheetHead} collapsable={false}>
        <Text style={styles.sheetTitle}>{title}</Text>
        {/* A 44pt frame of its own rather than hitSlop: hitSlop widens where a
            finger lands but not the element VoiceOver and Switch Control
            focus, which measured 39×18pt on the simulator. */}
        <Pressable accessibilityRole="button" disabled={busy} accessibilityState={{ disabled: busy }} onPress={() => router.back()} style={styles.sheetCloseTarget} testID="sheet-close">
          <Text style={styles.sheetClose}>Close</Text>
        </Pressable>
      </View>
      {children}
    </View>
  );
  return fullScreen ? <SafeAreaView style={styles.screen}><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 24 }}>{content}</ScrollView></SafeAreaView> : content;
}

const Centered = ({ children }: { children: React.ReactNode }) => (
  <View style={styles.centered}><Text style={styles.dim}>{children}</Text></View>
);

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.void },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  dim: { color: theme.dim },
  title: { color: theme.fg, fontSize: 15, fontWeight: "600" },
  headTitle: { alignItems: "center" },
  status: { flexDirection: "row", alignItems: "center", gap: 10 },

  space: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 15 },
  avatar: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarNumber: { position: "absolute", top: 15, left: 8, right: 8, textAlign: "center", fontFamily: theme.mono, fontSize: 14, lineHeight: 17, fontWeight: "600" },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: theme.line, marginLeft: 70 },
  spaceName: { color: theme.fg, fontSize: 16, fontWeight: "600" },
  spaceMeta: { color: theme.dim, fontFamily: theme.mono, fontSize: 11, marginTop: 2 },
  badge: { backgroundColor: theme.peach, color: theme.void, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, fontSize: 12, fontWeight: "600", overflow: "hidden" },

  groupLabel: { color: theme.dim, fontSize: 11, paddingHorizontal: 16, paddingTop: 20, paddingBottom: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 15 },
  rowBody: { flex: 1, gap: 2 },
  rowLine: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  rowTitle: { color: theme.fg, fontSize: 15, fontWeight: "600", flex: 1 },
  rowSaid: { color: theme.dim, fontSize: 13, flex: 1 },
  rowTyping: { color: theme.working, fontStyle: "italic" },
  rowStatus: { fontSize: 10, letterSpacing: 0.5 },
  rowMeta: { color: theme.dim, fontFamily: theme.mono, fontSize: 10 },

  action: { margin: 16, minHeight: 48, borderWidth: 1, borderStyle: "dashed", borderColor: theme.lineBright, borderRadius: 10, borderCurve: "continuous", alignItems: "center", justifyContent: "center" },
  actionText: { color: theme.peach, fontSize: 13 },
  actionPrimary: { backgroundColor: theme.peach, borderStyle: "solid", borderColor: theme.peach },
  actionPrimaryText: { color: theme.void, fontWeight: "600" },

  sheet: { padding: 16, gap: 10 },

  sheetHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  // Leave the close action its own lane. A long title previously measured
  // through it and into the first workspace row on an iPhone form sheet.
  sheetTitle: { color: theme.fg, fontSize: 17, fontWeight: "600", flex: 1, marginRight: 12 },
  sheetClose: { color: theme.peach, fontSize: 15 },
  sheetCloseTarget: { minWidth: 44, minHeight: 44, paddingLeft: 12, alignItems: "flex-end", justifyContent: "center" },
  label: { color: theme.dim, fontSize: 11, letterSpacing: 1.2 },
  input: { backgroundColor: theme.void, borderWidth: 1, borderColor: theme.lineBright, borderRadius: 8, borderCurve: "continuous", color: theme.fg, fontFamily: theme.mono, fontSize: 15, padding: 12, minHeight: 46 },
  kinds: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { borderWidth: 1, borderColor: theme.line, borderRadius: 999, paddingHorizontal: 12, minHeight: 44, justifyContent: "center", marginRight: 8 },
  chipOn: { borderColor: theme.lineBright, backgroundColor: theme.raised },
  chipText: { color: theme.dim, fontSize: 12, maxWidth: 200 },
  chipTextOn: { color: theme.fg },
  err: { color: theme.rose, fontSize: 13 },
  go: { backgroundColor: theme.peach, borderRadius: 10, borderCurve: "continuous", minHeight: 48, alignItems: "center", justifyContent: "center", marginTop: 4 },
  goOff: { opacity: 0.35 },
  goText: { color: theme.void, fontWeight: "600", fontSize: 16 },
  note: { color: theme.dim, fontSize: 12, textAlign: "center" },
  modes: { gap: 8, marginBottom: 16 },
  mode: {
    borderWidth: 1,
    borderColor: theme.line,
    borderRadius: 10, borderCurve: "continuous",
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  modeOn: { borderColor: theme.lineBright, backgroundColor: theme.raised },
  // The one that asks nothing before acting is worth reading twice.
  modeUnsafe: { borderColor: theme.rose },
  modeLabel: { color: theme.dim, fontSize: 15, fontWeight: "600" },
  modeLabelOn: { color: theme.fg },
  modeWhy: { color: theme.dim, fontSize: 12, marginTop: 2 },
});
