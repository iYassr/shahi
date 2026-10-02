import { plainHeaderRight } from "@/lib/header-controls";
import { ComputerSwitcher } from "@/components/computer-switcher";
import { LinkBadge } from "@/components/link-badge";
import { SafeAreaView } from "react-native-safe-area-context";
import { ConnectionHealth } from "@/components/connection-health";
import { Unreachable } from "@/components/unreachable";
import { OtherComputers } from "@/components/other-computers";
import { connectionHealth } from "@shahi/shared";
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
import { defaultAgentKind, folderName, modesFor, type DashboardPane, type Session, type Space } from "@shahi/shared";
import { landed, refused } from "@/lib/feel";
import { openPane, openSpace } from "@/lib/navigate";
import { useSession } from "@/lib/session";
import { theme, statusColor } from "@/lib/theme";
import { agentLabel } from "@shahi/shared";
import { Avatar } from "@/components/avatar";
import { conversationLabel, paneTitle } from "@/components/conversation-label";
import { AgentIcon, Icon } from "@/components/icons";
import { FolderBrowser, type FolderChoice } from "@/components/folder-browser";

export function Spaces({ session }: { session: Session | null }) {
  // Same header furniture as the Agents tab — the two lists are siblings and
  // should read as one app, not two designs.
  const { activeComputerId, api, link, error, server, reconnect, computers = [], control } = useSession();
  const computerName = computers.find(c => c.id === activeComputerId)?.name;
  const health = connectionHealth({ link, error, computerName, transport: server?.startsWith("ssh:") ? "ssh" : "relay", backend: control?.handshake?.backend });
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
  if (!session) return <>{header}<Unreachable title={health?.title ?? "Connecting to your computer…"}
    message={health?.detail ?? "Your spaces will appear once the computer connects."} server={computerName || server || ""}
    onRetry={reconnect} onSwitch={() => router.push("/computers")} alternatives={<OtherComputers />} /></>;

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
          <Pressable accessibilityRole="button" disabled={!!health} accessibilityState={{ disabled: !!health }} style={styles.action} onPress={() => router.push("/new-space")}>
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
                {pane.status === "blocked" ? "waiting" : pane.status}
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

export function NewSpace({ session, onCreated, onCancel, forAgent = false }: {
  session: Session; onCreated: (workspaceId: string) => void; onCancel?: () => void;
  /** Opened by New agent: the space is where that agent will work, and its form comes next. */
  forAgent?: boolean;
}) {
  const { api } = useSession();
  const largeText = useLargeText();
  const [name, setName] = useState("");
  /** The person typed the name: choosing a folder no longer renames the space. */
  const named = useRef(false);
  const [folder, setFolder] = useState<FolderChoice | null>(null);
  /** The typed-path field, for a folder outside home or a power user. */
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A new space usually sits beside an existing one.
  const recent = useMemo(() => {
    const seen = new Map<string, FolderChoice>();
    for (const w of session.workspaces) if (w.cwdPath && !seen.has(w.cwdPath)) seen.set(w.cwdPath, { path: w.cwdPath, display: w.cwd ?? w.cwdPath });
    return [...seen.values()];
  }, [session]);
  // Absolute only: herdr does not expand `~` and does not reject it either,
  // it silently uses $HOME. The browser hands back the listing's absolute path.
  const cwd = typing ? typed.trim() : folder?.path ?? "";

  function nameAfter(path: string) {
    if (!named.current) setName(folderName(path));
  }

  function choose(choice: FolderChoice) {
    setFolder(choice);
    setError(null);
    nameAfter(choice.display);
  }

  async function create() {
    setBusy(true);
    try {
      const { workspaceId } = await api.createWorkspace({ label: name.trim() || "new space", cwd });
      onCreated(workspaceId);
    } catch (e) {
      // The computer says what is wrong with the folder in words (`folderProblem`).
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <SheetBody title={forAgent ? "New agent" : "New space"} fullScreen busy={busy} onClose={onCancel}>
      {/* What a space is, where the word first appears: a new person met
          "Choose a space" before anything had said what one was (simulator
          run of build 32). */}
      <Text style={styles.intro}>
        {forAgent ? "Agents work in a space: a folder on your computer. Choose this one's folder, then the agent." : "A space is a folder on your computer that agents work in."}
      </Text>
      {/* Beside the label rather than under the browser, where a long home
          folder put it a screen or two out of sight (simulator run of build 32). */}
      <View style={styles.labelRow}>
        <Text style={styles.label}>FOLDER</Text>
        <Pressable accessibilityRole="button" style={styles.changeTarget} onPress={() => { setTyping((t) => !t); setError(null); }} testID="type-path">
          <Text style={styles.sheetClose}>{typing ? "Browse folders instead" : "Type a path instead"}</Text>
        </Pressable>
      </View>
      {!typing && (folder ? (
        <View style={styles.chosen} testID="chosen-folder">
          <Icon name="folder" size={18} color={theme.peach} />
          <Text style={styles.chosenPath} numberOfLines={largeText ? 3 : 1} ellipsizeMode="head">{folder.display}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Change folder" style={styles.changeTarget} onPress={() => setFolder(null)}>
            <Text style={styles.sheetClose}>Change</Text>
          </Pressable>
        </View>
      ) : (
        <FolderBrowser recent={recent} onChoose={choose} />
      ))}
      {typing && (
        <TextInput
          style={styles.input}
          value={typed}
          onChangeText={(text) => { setTyped(text); nameAfter(text); }}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          testID="new-space-folder"
          placeholder="/home/you/project"
          placeholderTextColor={theme.dim}
          accessibilityLabel="Space folder"
        />
      )}
      <Text style={styles.label}>NAME</Text>
      <TextInput
        style={styles.input}
        value={name}
        onChangeText={(text) => { named.current = true; setName(text); }}
        placeholder="what you are working on"
        placeholderTextColor={theme.dim}
        accessibilityLabel="Space name"
      />
      {error && <Text accessibilityRole="alert" style={styles.err}>{error}</Text>}
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy || !cwd }} style={[styles.go, (busy || !cwd) && styles.goOff]} disabled={busy || !cwd} onPress={() => void create()} testID="create-space">
        <Text style={styles.goText}>{busy ? "Creating…" : forAgent ? "Create space and continue" : "Create space"}</Text>
      </Pressable>
    </SheetBody>
  );
}

/**
 * The first step of "new agent" when it starts from the Agents tab rather
 * than from inside a space, and there are spaces to choose from: which space.
 * The form under it is the same one a space's own "+ New agent" opens — the
 * agent is the thing being made, and where it lives is a choice, not a place
 * you have to navigate to first. With no spaces at all, New agent starts at
 * the folder instead (`app/new-agent.tsx`).
 */
export function PickSpace({ session, onPick, onNewSpace }: { session: Session; onPick: (space: Space) => void; onNewSpace?: () => void }) {
  // Making the space here continues to its agent; the standalone sheet is the fallback.
  const newSpace = onNewSpace ?? (() => router.replace("/new-space"));
  return (
    <SheetBody title="Choose a space" fullScreen>
      <View>
        {/* A new agent often wants a new folder; on build 28 this list
            offered only the spaces that already existed (device audit). */}
        <Pressable accessibilityRole="button" style={[styles.action, styles.actionTop]} onPress={newSpace} testID="pick-new-space">
          <Text style={styles.actionText}>+ New space</Text>
        </Pressable>
        {/* Named by label and folder. herdr's workspace number was drawn here
            and read first, "1, tip-calc, ~/ShahiFresh/tip-calc", and means
            nothing away from herdr's keyboard (simulator run of build 32). */}
        {session.workspaces.map((item) => (
          <Pressable accessibilityRole="button" accessibilityLabel={[item.label, item.cwd].filter(Boolean).join(", ")} key={item.workspaceId} style={styles.space} onPress={() => onPick(item)} testID={`pick-${item.workspaceId}`}>
            <View style={styles.avatar}>
              <Icon name="folder" size={30} color={statusColor(item.status)} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.spaceName}>{item.label}</Text>
              {!!item.cwd && <Text style={styles.spaceMeta} numberOfLines={1}>{item.cwd}</Text>}
            </View>
          </Pressable>
        ))}
      </View>
    </SheetBody>
  );
}

export function NewAgent({ space, onStarted }: { space: Space; onStarted: (paneId: string) => void }) {
  const { api, lastAgent, rememberAgent } = useSession();
  // As it was when the form opened: what is remembered next is for the next form.
  const [preferred] = useState(lastAgent);
  const attempt = useRef<{ key: string; id: string } | null>(null);
  const [opened] = useState(() => ({ workspaceId: space.workspaceId, label: space.label }));
  const replaced = space.workspaceId !== opened.workspaceId || space.label !== opened.label;
  useEffect(() => { if (replaced) attempt.current = null; }, [replaced]);
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
      const initial = defaultAgentKind(available, preferred);
      if (initial) chooseKind(initial);
      else { setKind(null); setMode(null); }
    }).catch((e) => {
      if (active) setLoadError(e instanceof Error ? e.message : "Could not load agents.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, loadAttempt]);

  async function start() {
    if (replaced || !kind || loading || loadError || starting.current) return;
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
      // Started, whether or not this form is still open to see it.
      rememberAgent(kind);
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
    <SheetBody title={`New agent in ${opened.label}`} fullScreen busy={busy}>
      <Stack.Screen options={{ gestureEnabled: !busy }} />
      {replaced && <Text accessibilityRole="alert" style={styles.err}>This space changed while you were choosing an agent. Close this screen and choose the space again.</Text>}
      {loading && <Text style={styles.note}>Finding your agents…</Text>}
      {loadError && <><Text style={styles.err}>{loadError}</Text><Pressable accessibilityRole="button" testID="retry-agent-list" onPress={() => setLoadAttempt((n) => n + 1)}><Text style={styles.actionText}>Try again</Text></Pressable></>}
      {!loading && !loadError && kinds.length === 0 && <Text style={styles.note}>No agents are installed on this computer yet.</Text>}
      <Text style={styles.label}>AGENT</Text>
      {/* The chosen agent is marked three ways, accent border, check and
          weight, because a slightly lighter fill was all that told it apart
          (simulator run of build 32). Each wears the icon its conversations
          have in the lists. */}
      <View style={styles.kinds}>
        {kinds.map((k) => (
          <Pressable accessibilityRole="button" accessibilityLabel={agentLabel(k)} accessibilityState={{ selected: k === kind }} key={k} style={[styles.agentChip, k === kind && styles.agentChipOn]} onPress={() => chooseKind(k)} testID={`agent-kind-${k}`} disabled={busy || loading}>
            <AgentIcon kind={k} size={18} />
            <Text style={[styles.agentChipText, k === kind && styles.chipTextOn]}>{agentLabel(k)}</Text>
            {k === kind && <Text style={styles.agentChipCheck}>✓</Text>}
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
                  {option.id === mode ? "✓ " : ""}{option.label}
                </Text>
                {option.unsafe && <Text style={{ color: theme.rose, fontSize: 13, fontWeight: "600" }}>No approval before changes</Text>}
                <Text style={styles.modeWhy}>{option.description}</Text>
              </Pressable>
            ))}
          </View>
        </>
      )}
      {kind && modes.length === 0 && <Text style={styles.note}>{agentLabel(kind)} uses its own approval settings on your computer.</Text>}
      {error && <Text style={styles.err}>{error}</Text>}
      <Pressable accessibilityRole="button" style={[styles.go, (busy || !kind) && styles.goOff]} disabled={replaced || busy || !kind || loading || !!loadError} testID="start-agent" onPress={() => void start()}>
        <Text style={styles.goText}>
          {phase === "starting" ? `Waiting for ${kind ? agentLabel(kind) : "agent"}…` : `Start ${kind ? agentLabel(kind) : "agent"}${modes.find(option => option.id === mode)?.unsafe ? " without approvals" : ""}`}
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
function SheetBody({ title, children, fullScreen = false, busy = false, onClose = () => router.back() }: { title: string; children: React.ReactNode; fullScreen?: boolean; busy?: boolean; onClose?: () => void }) {
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
        <Pressable accessibilityRole="button" disabled={busy} accessibilityState={{ disabled: busy }} onPress={onClose} style={styles.sheetCloseTarget} testID="sheet-close">
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

  chosen: { flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderColor: theme.lineBright, borderRadius: 10, borderCurve: "continuous", paddingLeft: 12, minHeight: 48 },
  chosenPath: { color: theme.fg, fontFamily: theme.mono, fontSize: 14, flex: 1 },
  changeTarget: { minHeight: 44, minWidth: 44, paddingHorizontal: 12, justifyContent: "center", alignSelf: "flex-start" },
  actionTop: { marginHorizontal: 0, marginTop: 0 },
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
  labelRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" },
  intro: { color: theme.dim, fontSize: 14, lineHeight: 19 },
  input: { backgroundColor: theme.void, borderWidth: 1, borderColor: theme.lineBright, borderRadius: 8, borderCurve: "continuous", color: theme.fg, fontFamily: theme.mono, fontSize: 15, padding: 12, minHeight: 46 },
  kinds: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chipTextOn: { color: theme.fg, fontWeight: "600" },
  // A point less padding while selected pays for the wider border, so a chip
  // grows by its check alone.
  agentChip: { flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderColor: theme.line, borderRadius: 999, paddingHorizontal: 14, minHeight: 44 },
  agentChipOn: { borderWidth: 2, borderColor: theme.peach, backgroundColor: theme.raised, paddingHorizontal: 13 },
  agentChipText: { color: theme.dim, fontSize: 14 },
  agentChipCheck: { color: theme.peach, fontSize: 14, fontWeight: "700" },
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
  modeOn: { borderColor: theme.peach, backgroundColor: theme.raised },
  // The one that asks nothing before acting is worth reading twice.
  modeUnsafe: { borderColor: theme.rose },
  modeLabel: { color: theme.dim, fontSize: 15, fontWeight: "600" },
  modeLabelOn: { color: theme.fg },
  modeWhy: { color: theme.dim, fontSize: 12, marginTop: 2 },
});
