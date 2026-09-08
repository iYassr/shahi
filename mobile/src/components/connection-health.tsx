import { router } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { connectionHealth } from "@shahi/shared";
import { useSession } from "@/lib/session";
import { theme } from "@/lib/theme";

export function ConnectionHealth() {
  const { link, error, server, reconnect } = useSession();
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState<Error | null>(null);
  const health = connectionHealth({ link, error: error ?? (link === "live" ? null : retryError), transport: server?.startsWith("ssh:") ? "ssh" : "relay" });
  if (!health) return null;
  return <View style={styles.card} accessibilityLiveRegion="polite">
    <Text style={styles.title}>{health.title}</Text>
    <Text style={styles.detail}>{health.detail}</Text>
    <Pressable testID="switch-computer" accessibilityRole="button" style={styles.retry} onPress={() => router.push("/computers")}>
      <Text style={styles.action}>Switch computer</Text>
    </Pressable>
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy} style={styles.retry} onPress={() => {
      setBusy(true); setRetryError(null);
      void reconnect().catch((e) => setRetryError(e instanceof Error ? e : new Error("Connection failed"))).finally(() => setBusy(false));
    }}><Text style={styles.action}>{busy ? "Retrying…" : "Retry connection"}</Text></Pressable>
  </View>;
}
const styles = StyleSheet.create({
  card: { marginHorizontal: 16, marginVertical: 8, padding: 14, gap: 6, backgroundColor: theme.surface, borderColor: theme.line, borderWidth: 1, borderRadius: 12 },
  title: { color: theme.peach, fontWeight: "600", fontSize: 15 },
  detail: { color: theme.fg, fontSize: 14, lineHeight: 20 },
  retry: { minHeight: 44, justifyContent: "center", alignSelf: "flex-start", paddingHorizontal: 8 },
  action: { color: theme.peach, fontWeight: "600", fontSize: 14 },
});
