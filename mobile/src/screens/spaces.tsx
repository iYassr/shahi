/**
 * Spaces: where things live, and where new work goes.
 *
 * The other half of herdr's own sidebar split. Agents is triage; this is
 * structure — and it is the only place plain shells are reachable, since the
 * Agents view filters them out and they are roughly half the panes in a real
 * session.
 *
 * Navigation is routes, not state: a space is pushed, and the new-space /
 * new-agent forms are formSheet routes. The router owns back — the hardware
 * button, the edge swipe and drag-to-dismiss all work without this file
 * re-teaching any of them, which is exactly what the old BackHandler wiring
 * existed to do.
 */
import { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { router, Stack } from "expo-router";
import { modesFor, type DashboardPane, type Session, type Space } from "@shahi/shared";
import { api } from "@/lib/api";
import { landed, refused } from "@/lib/feel";
import { openPane } from "@/lib/navigate";
import { useSession } from "@/lib/session";
import { theme } from "@/lib/theme";
import { Avatar } from "@/components/avatar";

export function Spaces({ session }: { session: Session | null }) {
  // Same header furniture as the Agents tab — the two lists are siblings and
  // should read as one app, not two designs.
  const { server, link } = useSession();
  if (!session) return <Centered>Connecting…</Centered>;

  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <View style={styles.status}>
              <Text style={[styles.statusText, { color: theme.dim }]} numberOfLines={1}>
                {server.replace(/^https?:\/\//, "")}
              </Text>
              <Text style={[styles.statusText, { color: link === "live" ? theme.mint : theme.dim }]}>
                {link === "live" ? "LIVE" : link === "lost" ? "OFFLINE" : "…"}
              </Text>
            </View>
          ),
        }}
      />
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        data={session.workspaces}
        keyExtractor={(w) => w.workspaceId}
        ListHeaderComponent={
          session.workspaces.length > 0 ? (
            <Text style={styles.groupLabel}>
              {session.workspaces.length} SPACE{session.workspaces.length === 1 ? "" : "S"}
            </Text>
          ) : null
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
              style={styles.space}
              onPress={() =>
                router.push({
                  pathname: "/space/[workspaceId]",
                  params: { workspaceId: item.workspaceId },
                })
              }
            >
              <View style={[styles.avatar, { borderColor: statusColor(item.status) }]}>
                <Text style={[styles.avatarNumber, { color: statusColor(item.status) }]}>
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
          <Pressable style={styles.action} onPress={() => router.push("/new-space")}>
            <Text style={styles.actionText}>+ New space</Text>
          </Pressable>
        }
      />
    </View>
  );
}

export function SpaceDetail({ space, session }: { space: Space; session: Session }) {
  const tabs = useMemo(
    () => session.tabs.filter((t) => t.workspaceId === space.workspaceId),
    [session, space],
  );

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
                  <PaneRow pane={pane} onPress={() => openPane(pane.paneId)} />
                </View>
              ))}
            </View>
          );
        }}
        ListFooterComponent={
          <Pressable
            style={[styles.action, styles.actionPrimary]}
            onPress={() =>
              router.push({
                pathname: "/new-agent",
                params: { workspaceId: space.workspaceId },
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
function PaneRow({ pane, onPress }: { pane: DashboardPane; onPress: () => void }) {
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <Avatar pane={pane} />
      <View style={styles.rowBody}>
        <View style={styles.rowLine}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {pane.title ?? (pane.isAgent ? pane.paneId : "shell")}
          </Text>
          {/* Same quieting as the Agents rows: idle says nothing, and the
              second line only exists when there is something to preview. */}
          {pane.status !== "idle" && (
            <Text style={[styles.rowStatus, { color: statusColor(pane.status) }]}>
              {pane.status}
            </Text>
          )}
          <Text style={styles.rowMeta}>{pane.agent ?? pane.paneId}</Text>
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
}

export function NewSpace({ session, onCreated }: { session: Session; onCreated: () => void }) {
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
      await api.rpc("workspace.create", { label: name.trim() || "new space", cwd, focus: false });
      onCreated();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <SheetBody title="New space">
      <Text style={styles.label}>NAME</Text>
      <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="what you are working on" placeholderTextColor={theme.dim} />
      <Text style={styles.label}>FOLDER</Text>
      {/* A wrapping row like the agent-kind chips: a FlatList cannot size
          itself inside this fit-to-contents sheet, and the chips floated up
          over the title. */}
      <View style={styles.kinds}>
        {suggestions.map((item) => (
          <Pressable key={item} style={[styles.chip, item === cwd && styles.chipOn]} onPress={() => setCwd(item)}>
            <Text style={[styles.chipText, item === cwd && styles.chipTextOn]} numberOfLines={1}>{item}</Text>
          </Pressable>
        ))}
      </View>
      {error && <Text style={styles.err}>{error}</Text>}
      <Pressable style={[styles.go, (busy || !cwd) && styles.goOff]} disabled={busy || !cwd} onPress={() => void create()}>
        <Text style={styles.goText}>{busy ? "Creating…" : "Create space"}</Text>
      </Pressable>
    </SheetBody>
  );
}

export function NewAgent({ space, onStarted }: { space: Space; onStarted: (paneId: string) => void }) {
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
  useEffect(() => setMode(modes[0]?.id ?? null), [kind]);

  useMemo(() => {
    void api.agents().then((d) => {
      setKinds(d.agents.map((a) => a.kind));
      setKind((k) => k ?? d.agents[0]?.kind ?? null);
    });
  }, []);

  async function start() {
    if (!kind) return;
    setPhase("starting");
    try {
      // One call: the server makes the tab, waits for its shell, then starts the
      // agent. herdr blocks until the agent reports readiness, which on a cold
      // start is genuinely slow.
      const { paneId } = await api.startAgent({
        workspaceId: space.workspaceId,
        cwd: space.cwdPath,
        label: null,
        kind,
        name: kind,
        mode,
      });
      landed();
      onStarted(paneId);
    } catch (e) {
      refused();
      setError((e as Error).message);
      setPhase("idle");
    }
  }

  const busy = phase !== "idle";
  return (
    <SheetBody title={`New agent in ${space.label}`}>
      <Text style={styles.label}>AGENT</Text>
      <View style={styles.kinds}>
        {kinds.map((k) => (
          <Pressable key={k} style={[styles.chip, k === kind && styles.chipOn]} onPress={() => setKind(k)} disabled={busy}>
            <Text style={[styles.chipText, k === kind && styles.chipTextOn]}>{k}</Text>
          </Pressable>
        ))}
      </View>
      {modes.length > 0 && (
        <>
          <Text style={styles.label}>PERMISSIONS</Text>
          <View style={styles.modes}>
            {modes.map((option) => (
              <Pressable
                key={option.id}
                style={[
                  styles.mode,
                  option.id === mode && styles.modeOn,
                  option.id === mode && option.unsafe && styles.modeUnsafe,
                ]}
                onPress={() => setMode(option.id)}
                disabled={busy}
              >
                <Text style={[styles.modeLabel, option.id === mode && styles.modeLabelOn]}>
                  {option.label}
                </Text>
                <Text style={styles.modeWhy}>{option.description}</Text>
              </Pressable>
            ))}
          </View>
        </>
      )}
      {error && <Text style={styles.err}>{error}</Text>}
      <Pressable style={[styles.go, (busy || !kind) && styles.goOff]} disabled={busy || !kind} onPress={() => void start()}>
        <Text style={styles.goText}>
          {phase === "starting" ? `Waiting for ${kind}…` : `Start ${kind ?? "agent"}`}
        </Text>
      </Pressable>
      <Text style={styles.note}>A cold start can take half a minute.</Text>
    </SheetBody>
  );
}

/**
 * The inside of a formSheet route: a title row, then the form.
 *
 * The sheet itself — the rounded card, the dimming, drag-to-dismiss, and
 * moving out of the keyboard's way — is the presentation's job now, which is
 * why this replaced an absolutely positioned View with a hand-measured
 * keyboard lift.
 */
function SheetBody({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.sheet}>
      <View style={styles.sheetHead}>
        <Text style={styles.sheetTitle}>{title}</Text>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.sheetClose}>Close</Text>
        </Pressable>
      </View>
      {children}
    </View>
  );
}

const Centered = ({ children }: { children: React.ReactNode }) => (
  <View style={styles.centered}><Text style={styles.dim}>{children}</Text></View>
);

const statusColor = (s: string) =>
  s === "working" ? theme.mint : s === "blocked" ? theme.peach : theme.dim;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.void },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  dim: { color: theme.dim },
  title: { color: theme.fg, fontFamily: theme.mono, fontSize: 15, fontWeight: "600" },
  headTitle: { alignItems: "center" },
  status: { flexDirection: "row", alignItems: "center", gap: 10 },
  statusText: { fontFamily: theme.mono, fontSize: 11, letterSpacing: 1 },

  space: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 15 },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.surface,
  },
  avatarNumber: { fontFamily: theme.mono, fontSize: 16, fontWeight: "600" },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: theme.line, marginLeft: 70 },
  spaceName: { color: theme.fg, fontSize: 16, fontWeight: "600" },
  spaceMeta: { color: theme.dim, fontFamily: theme.mono, fontSize: 11, marginTop: 2 },
  badge: { backgroundColor: theme.peach, color: theme.void, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, fontFamily: theme.mono, fontSize: 12, fontWeight: "600", overflow: "hidden" },

  groupLabel: { color: theme.dim, fontFamily: theme.mono, fontSize: 11, letterSpacing: 1.2, paddingHorizontal: 16, paddingTop: 20, paddingBottom: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 15 },
  rowBody: { flex: 1, gap: 2 },
  rowLine: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  rowTitle: { color: theme.fg, fontSize: 15, fontWeight: "600", flex: 1 },
  rowSaid: { color: theme.dim, fontSize: 13, flex: 1 },
  rowTyping: { color: theme.mint, fontStyle: "italic" },
  rowStatus: { fontFamily: theme.mono, fontSize: 10, letterSpacing: 0.5 },
  rowMeta: { color: theme.dim, fontFamily: theme.mono, fontSize: 10 },

  action: { margin: 16, minHeight: 48, borderWidth: 1, borderStyle: "dashed", borderColor: theme.lineBright, borderRadius: 10, borderCurve: "continuous", alignItems: "center", justifyContent: "center" },
  actionText: { color: theme.peach, fontFamily: theme.mono, fontSize: 13 },
  actionPrimary: { backgroundColor: theme.peach, borderStyle: "solid", borderColor: theme.peach },
  actionPrimaryText: { color: theme.void, fontWeight: "600" },

  sheet: { padding: 16, gap: 10 },
  sheetHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  sheetTitle: { color: theme.fg, fontSize: 17, fontWeight: "600" },
  sheetClose: { color: theme.peach, fontSize: 15 },
  label: { color: theme.dim, fontFamily: theme.mono, fontSize: 11, letterSpacing: 1.2 },
  input: { backgroundColor: theme.void, borderWidth: 1, borderColor: theme.lineBright, borderRadius: 8, borderCurve: "continuous", color: theme.fg, fontFamily: theme.mono, fontSize: 15, padding: 12, minHeight: 46 },
  kinds: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { borderWidth: 1, borderColor: theme.line, borderRadius: 999, paddingHorizontal: 12, minHeight: 40, justifyContent: "center", marginRight: 8 },
  chipOn: { borderColor: theme.peach },
  chipText: { color: theme.dim, fontFamily: theme.mono, fontSize: 12, maxWidth: 200 },
  chipTextOn: { color: theme.peach },
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
  modeOn: { borderColor: theme.peach },
  // The one that asks nothing before acting is worth reading twice.
  modeUnsafe: { borderColor: theme.rose },
  modeLabel: { color: theme.dim, fontSize: 15, fontWeight: "600" },
  modeLabelOn: { color: theme.fg },
  modeWhy: { color: theme.dim, fontSize: 12, marginTop: 2 },
});
