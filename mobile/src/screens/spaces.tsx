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
import { AGENT_COLORS, GLYPH, theme } from "@/lib/theme";

export function Spaces({ session }: { session: Session | null }) {
  if (!session) return <Centered>Connecting…</Centered>;

  return (
    <View style={styles.screen}>
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        data={session.workspaces}
        keyExtractor={(w) => w.workspaceId}
        renderItem={({ item }) => {
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
              <Text style={[styles.glyph, { color: statusColor(item.status) }]}>
                {GLYPH[item.status] ?? "·"}
              </Text>
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
              {panes.map((pane) => (
                <PaneRow key={pane.paneId} pane={pane} onPress={() => openPane(pane.paneId)} />
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

function PaneRow({ pane, onPress }: { pane: DashboardPane; onPress: () => void }) {
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <Text style={[styles.glyph, { color: statusColor(pane.status) }]}>
        {GLYPH[pane.status] ?? "·"}
      </Text>
      {pane.isAgent && (
        <Text style={[styles.mark, { color: AGENT_COLORS[pane.agent ?? ""] ?? theme.dim }]}>✳</Text>
      )}
      <Text style={styles.rowTitle} numberOfLines={1}>
        {pane.title ?? (pane.isAgent ? pane.paneId : "shell")}
      </Text>
      <Text style={styles.rowMeta}>{pane.agent ?? pane.paneId}</Text>
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
      <FlatList
        data={suggestions}
        horizontal
        keyExtractor={(p) => p}
        showsHorizontalScrollIndicator={false}
        // Otherwise the first tap only dismisses the keyboard and is swallowed,
        // so picking a folder while naming the space takes two taps.
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <Pressable style={[styles.chip, item === cwd && styles.chipOn]} onPress={() => setCwd(item)}>
            <Text style={[styles.chipText, item === cwd && styles.chipTextOn]} numberOfLines={1}>{item}</Text>
          </Pressable>
        )}
      />
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

  space: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: theme.line },
  spaceName: { color: theme.fg, fontSize: 16, fontWeight: "600" },
  spaceMeta: { color: theme.dim, fontFamily: theme.mono, fontSize: 11, marginTop: 2 },
  badge: { backgroundColor: theme.peach, color: theme.void, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, fontFamily: theme.mono, fontSize: 12, fontWeight: "600", overflow: "hidden" },

  groupLabel: { color: theme.dim, fontFamily: theme.mono, fontSize: 11, letterSpacing: 1.2, paddingHorizontal: 16, paddingTop: 20, paddingBottom: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 11 },
  glyph: { fontFamily: theme.mono, fontSize: 13, width: 14 },
  mark: { fontFamily: theme.mono, fontSize: 13 },
  rowTitle: { color: theme.fg, fontFamily: theme.mono, fontSize: 13, flex: 1 },
  rowMeta: { color: theme.dim, fontFamily: theme.mono, fontSize: 11 },

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
