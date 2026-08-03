/**
 * Spaces: where things live, and where new work goes.
 *
 * The other half of herdr's own sidebar split. Agents is triage; this is
 * structure — and it is the only place plain shells are reachable, since the
 * Agents view filters them out and they are roughly half the panes in a real
 * session.
 */
import { useEffect, useMemo, useState } from "react";
import {
  BackHandler,
  FlatList,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { modesFor, type DashboardPane, type Session, type Space } from "@shahi/shared";
import { api } from "@/lib/api";
import { landed, refused } from "@/lib/feel";
import { AGENT_COLORS, GLYPH, theme } from "@/lib/theme";

interface Props {
  session: Session | null;
  onOpenPane: (paneId: string) => void;
  onChanged: () => void;
}

export function Spaces({ session, onOpenPane, onChanged }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState<"space" | "agent" | null>(null);

  // A space and a sheet are state rather than routes, so the system back button
  // does not know about them: without this it leaves the app from two screens
  // deep, which is not what a back button means anywhere else.
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (creating) {
        setCreating(null);
        return true;
      }
      if (open) {
        setOpen(null);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [creating, open]);

  if (!session) return <Centered>Connecting…</Centered>;

  const space = session.workspaces.find((w) => w.workspaceId === open);
  if (space) {
    return (
      <SpaceDetail
        space={space}
        session={session}
        onBack={() => setOpen(null)}
        onOpenPane={onOpenPane}
        onChanged={onChanged}
        creating={creating === "agent"}
        setCreating={(v) => setCreating(v ? "agent" : null)}
      />
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.topbar}>
        <Text style={styles.title}>Spaces</Text>
      </View>
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        data={session.workspaces}
        keyExtractor={(w) => w.workspaceId}
        renderItem={({ item }) => {
          const blocked = session.panes.filter(
            (p) => p.workspaceId === item.workspaceId && p.status === "blocked",
          ).length;
          return (
            <Pressable style={styles.space} onPress={() => setOpen(item.workspaceId)}>
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
          <Pressable style={styles.action} onPress={() => setCreating("space")}>
            <Text style={styles.actionText}>+ New space</Text>
          </Pressable>
        }
      />
      {creating === "space" && (
        <NewSpace
          session={session}
          onClose={() => setCreating(null)}
          onCreated={() => {
            setCreating(null);
            onChanged();
          }}
        />
      )}
    </View>
  );
}

function SpaceDetail({
  space,
  session,
  onBack,
  onOpenPane,
  onChanged,
  creating,
  setCreating,
}: {
  space: Space;
  session: Session;
  onBack: () => void;
  onOpenPane: (paneId: string) => void;
  onChanged: () => void;
  creating: boolean;
  setCreating: (v: boolean) => void;
}) {
  const tabs = useMemo(
    () => session.tabs.filter((t) => t.workspaceId === space.workspaceId),
    [session, space],
  );

  return (
    <View style={styles.screen}>
      <View style={styles.topbar}>
        <Pressable onPress={onBack} hitSlop={12}>
          <Text style={styles.back}>‹</Text>
        </Pressable>
        <View>
          <Text style={styles.title}>{space.label}</Text>
          <Text style={styles.spaceMeta}>{space.cwd ?? space.workspaceId}</Text>
        </View>
      </View>

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
                <PaneRow key={pane.paneId} pane={pane} onPress={() => onOpenPane(pane.paneId)} />
              ))}
            </View>
          );
        }}
        ListFooterComponent={
          <Pressable
            style={[styles.action, styles.actionPrimary]}
            onPress={() => setCreating(true)}
          >
            <Text style={styles.actionPrimaryText}>+ New agent</Text>
          </Pressable>
        }
      />

      {creating && (
        <NewAgent
          space={space}
          onClose={() => setCreating(false)}
          onStarted={(paneId) => {
            setCreating(false);
            onChanged();
            onOpenPane(paneId);
          }}
        />
      )}
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

function NewSpace({
  session,
  onClose,
  onCreated,
}: {
  session: Session;
  onClose: () => void;
  onCreated: () => void;
}) {
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
    <Sheet title="New space" onClose={onClose}>
      <Text style={styles.label}>NAME</Text>
      <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="what you are working on" placeholderTextColor={theme.dim} />
      <Text style={styles.label}>FOLDER</Text>
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
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
    </Sheet>
  );
}

function NewAgent({
  space,
  onClose,
  onStarted,
}: {
  space: Space;
  onClose: () => void;
  onStarted: (paneId: string) => void;
}) {
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
    <Sheet title={`New agent in ${space.label}`} onClose={onClose}>
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
    </Sheet>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const keyboard = useKeyboardHeight();
  return (
    // Lifted by the measured keyboard height rather than by
    // KeyboardAvoidingView, which does nothing for an absolutely positioned
    // sheet — it derives its padding from its own laid-out frame, and this one
    // is pinned to the bottom with no height of its own. Without the lift the
    // confirm button sits behind the keyboard, unreachable.
    <View style={[styles.sheetWrap, { paddingBottom: keyboard }]}>
      <View style={styles.sheet}>
        <View style={styles.sheetHead}>
          <Text style={styles.sheetTitle}>{title}</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={styles.sheetClose}>Close</Text>
          </Pressable>
        </View>
        {children}
      </View>
    </View>
  );
}

/** How much of the screen the keyboard is currently taking, in dp. */
function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const shown = Keyboard.addListener("keyboardDidShow", (e) => setHeight(e.endCoordinates.height));
    const hidden = Keyboard.addListener("keyboardDidHide", () => setHeight(0));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);
  return height;
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
  topbar: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: theme.line },
  title: { color: theme.fg, fontFamily: theme.mono, fontSize: 15, fontWeight: "600" },
  back: { color: theme.dim, fontSize: 26, lineHeight: 26 },

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

  sheetWrap: { position: "absolute", left: 0, right: 0, bottom: 0 },
  sheet: { backgroundColor: theme.surface, borderTopWidth: 1, borderTopColor: theme.lineBright, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, gap: 10 },
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
