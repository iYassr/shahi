import { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Agents } from "@/screens/agents";
import { onNotificationTapped } from "@/lib/push";
import { useSession } from "@/lib/session";
import { theme } from "@/lib/theme";
import { openPane } from "@/lib/navigate";

export default function AgentsTab() {
  const { ready, connected } = useSession();

  // A notification is about one pane, and the answer it wants is on that pane's
  // screen — so tapping it should land there rather than on the list.
  useEffect(() => onNotificationTapped(openPane), []);

  useEffect(() => {
    if (ready && !connected) router.replace("/connect");
  }, [ready, connected]);

  if (!ready || !connected) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={theme.peach} />
      </View>
    );
  }
  return (
    // Top edge only: the screen draws its own topbar, which sat under the
    // status bar without this — the clock rendered over the screen's title.
    // The bottom belongs to the native tab bar.
    <SafeAreaView edges={["top"]} style={{ flex: 1, backgroundColor: theme.void }}>
      <Agents onOpenPane={openPane} />
    </SafeAreaView>
  );
}
