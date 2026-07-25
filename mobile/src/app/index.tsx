/**
 * The shell: sign in, then the two views herdr itself has.
 *
 * Agents and Spaces are tabs rather than routes because they are two readings
 * of one snapshot, not two places — switching between them should never cost a
 * fetch or lose what is on screen.
 */
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
// react-native's own SafeAreaView is deprecated and warns at runtime; this is
// the supported one, and it already ships with the Expo template.
import { SafeAreaView } from "react-native-safe-area-context";
import { Agents } from "@/screens/agents";
import { Connect } from "@/screens/connect";
import { Spaces } from "@/screens/spaces";
import { onNotificationTapped } from "@/lib/push";
import { useSession } from "@/lib/session";
import { theme } from "@/lib/theme";

type Tab = "agents" | "spaces";

export default function Index() {
  const { ready, connected, session, signIn, refresh } = useSession();
  const [tab, setTab] = useState<Tab>("agents");

  // The object form rather than a template string: pane ids contain a colon
  // (`w4:p2`), and letting the router do the encoding keeps that honest.
  const openPane = (paneId: string) =>
    router.push({ pathname: "/pane/[paneId]", params: { paneId } });

  // A notification is about one pane, and the answer it wants is on that pane's
  // screen — so tapping it should land there rather than on the list.
  useEffect(() => onNotificationTapped(openPane), []);

  if (!ready) {
    return (
      <SafeAreaView style={[styles.safe, styles.centered]}>
        <ActivityIndicator color={theme.peach} />
      </SafeAreaView>
    );
  }

  if (!connected) {
    return (
      <SafeAreaView style={styles.safe}>
        <Connect onConnected={signIn} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.body}>
        {tab === "agents" ? (
          <Agents onOpenPane={openPane} />
        ) : (
          <Spaces session={session} onOpenPane={openPane} onChanged={refresh} />
        )}
      </View>
      <View style={styles.tabs}>
        <TabButton label="Agents" on={tab === "agents"} onPress={() => setTab("agents")} />
        <TabButton label="Spaces" on={tab === "spaces"} onPress={() => setTab("spaces")} />
      </View>
    </SafeAreaView>
  );
}

function TabButton({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable style={styles.tab} onPress={onPress}>
      <Text style={[styles.tabText, on && styles.tabTextOn]}>{label}</Text>
      <View style={[styles.tabMark, on && styles.tabMarkOn]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.void },
  centered: { alignItems: "center", justifyContent: "center" },
  body: { flex: 1 },
  tabs: { flexDirection: "row", borderTopWidth: 1, borderTopColor: theme.line },
  tab: { flex: 1, minHeight: 52, alignItems: "center", justifyContent: "center", gap: 5 },
  tabText: { color: theme.dim, fontFamily: theme.mono, fontSize: 13 },
  tabTextOn: { color: theme.peach },
  tabMark: { width: 18, height: 2, borderRadius: 2, backgroundColor: "transparent" },
  tabMarkOn: { backgroundColor: theme.peach },
});
