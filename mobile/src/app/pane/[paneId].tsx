import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Text } from "@/components/text";
import { Pane } from "@/screens/pane";
import { useSession } from "@/lib/session";
import { useOwnedRoute } from "@/lib/owned-route";
import { theme } from "@/lib/theme";

export default function PaneRoute() {
  // Route params arrive as string | string[]; a pane id is always the former.
  // `instance` is the occupant a notification was about (see below).
  const { paneId, view, instance, reply } = useLocalSearchParams<{ paneId: string; view?: string; instance?: string; reply?: string }>();
  const { session } = useSession();
  const owned = useOwnedRoute();

  // A pane can vanish under us — closed from the TUI while this was open.
  // Popping beats sitting on a dead conversation forever; the space route
  // already behaves this way.
  // A newly created agent may open before the refreshed list arrives.
  // Only dismiss an agent we have actually seen in that list.
  const observed = useRef<string | null>(null);
  const known = owned ? session?.panes.find((p) => p.paneId === String(paneId)) : undefined;
  const exists = known !== undefined;
  if (exists) observed.current = String(paneId);
  const gone = session != null && observed.current === String(paneId) && !exists;
  useEffect(() => {
    if (owned && gone && router.canGoBack()) router.back();
  }, [owned, gone]);

  // herdr reuses pane ids, so the id in the route can come to name another
  // program while this screen is open (see `DashboardPane.instanceId`), and an
  // agent can quit and leave its shell. The pane starts over when either
  // happens, so nothing of the conversation that ended stays on screen while a
  // fetch fails; the computer's session has already forgotten it. Learning
  // the occupant for the first time is not a change: a pane opened before the
  // list loaded would lose its place for nothing.
  const seen = useRef<{ instanceId?: string; agent?: boolean; generation: number }>({ generation: 0 });
  const occupant = known?.instanceId;
  if (occupant && seen.current.instanceId && occupant !== seen.current.instanceId) seen.current.generation++;
  else if (known && seen.current.agent && !known.isAgent) seen.current.generation++;
  if (occupant) seen.current.instanceId = occupant;
  if (known) seen.current.agent = known.isAgent;

  // A notification tapped after the id changed hands opened the new
  // conversation with no notice (pre-release bug hunt); this says the one it
  // was about has ended, until the person asks for what runs there now.
  const [openAnyway, setOpenAnyway] = useState(false);
  const ended = Boolean(instance && occupant && instance !== occupant && !openAnyway);

  // Never resolved against another computer: not even one render, because the
  // pane polls and its composer sends from the first. After every hook, so
  // their order holds when the computer changes under this route.
  if (!owned) return null;
  return (
    // Bottom only: the native header owns the top inset now.
    <SafeAreaView edges={["bottom"]} style={{ flex: 1, backgroundColor: theme.void }}>
      {ended ? (
        <View style={styles.ended} accessibilityRole="summary">
          <Text style={styles.endedText}>
            The conversation this notification was about has ended. Another program now runs in {String(paneId)}.
          </Text>
          <Pressable accessibilityRole="button" style={styles.endedAction} onPress={() => setOpenAnyway(true)}>
            <Text style={styles.endedActionText}>Open what runs there now</Text>
          </Pressable>
          <Pressable accessibilityRole="button" style={styles.endedAction} onPress={() => { if (router.canGoBack()) router.back(); }}>
            <Text style={styles.endedActionText}>Back</Text>
          </Pressable>
        </View>
      ) : (
        <Pane key={`${String(paneId)}#${seen.current.generation}`} paneId={String(paneId)} focusReply={reply === "1"} initialView={view === "screen" ? "screen" : "reader"} />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  ended: { flex: 1, justifyContent: "center", padding: 24, gap: 12 },
  endedText: { color: theme.fg, fontSize: 16, lineHeight: 22 },
  endedAction: { borderColor: theme.line, borderWidth: 1, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16, alignItems: "center" },
  endedActionText: { color: theme.peach, fontSize: 16 },
});
