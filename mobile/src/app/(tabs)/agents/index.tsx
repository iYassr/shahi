import { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { router } from "expo-router";
import { Agents } from "@/screens/agents";
import { useSession } from "@/lib/session";
import { theme } from "@/lib/theme";
import { openPane } from "@/lib/navigate";

export default function AgentsTab() {
  const { ready, connected } = useSession();

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
  return <Agents onOpenPane={openPane} />;
}
