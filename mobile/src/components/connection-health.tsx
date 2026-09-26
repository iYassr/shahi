import { router } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/components/text";
import { connectionHealth } from "@shahi/shared";
import { useSession } from "@/lib/session";
import { theme } from "@/lib/theme";

export function ConnectionHealth() {
  const session = useSession();
  return <ComputerHealth key={session.activeComputerId ?? "current"} session={session} />;
}

function ComputerHealth({ session }: { session: ReturnType<typeof useSession> }) {
  const { link, error, server, reconnect, online = true, activeComputerId, computers, control } = session;
  const computerName = computers?.find(computer => computer.id === activeComputerId)?.name;
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState<Error | null>(null);
  const health = connectionHealth({ link, online, computerName, error: error ?? (link === "live" ? null : retryError), transport: server?.startsWith("ssh:") ? "ssh" : "relay", backend: control?.handshake?.backend });
  if (!health) return null;
  return <View style={styles.card} accessibilityLiveRegion="polite">
    <Text style={styles.title}>{health.title}</Text>
    <Text style={styles.detail}>{health.detail}</Text>
    <Text style={styles.note}>Your draft stays here. Nothing is sent automatically.</Text>
    <View style={styles.actions}>
    <Pressable testID="switch-computer" accessibilityRole="button" style={styles.retry} onPress={() => router.push("/computers")}>
      <Text style={styles.action}>Switch computer</Text>
    </Pressable>
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy || !online }} disabled={busy || !online} style={styles.retry} onPress={() => {
      setBusy(true); setRetryError(null);
      void reconnect().catch((e) => setRetryError(e instanceof Error ? e : new Error("Connection failed"))).finally(() => setBusy(false));
    }}><Text style={styles.action}>{busy ? "Retrying…" : "Retry connection"}</Text></Pressable>
    </View>
  </View>;
}
const styles = StyleSheet.create({
  card: { marginHorizontal: 16, marginVertical: 8, padding: 14, gap: 6, backgroundColor: theme.surface, borderColor: theme.line, borderWidth: 1, borderRadius: 12 },
  title: { color: theme.peach, fontWeight: "600", fontSize: 15 },
  detail: { color: theme.fg, fontSize: 14, lineHeight: 20 },
  note: { color: theme.dim, fontSize: 12, lineHeight: 18 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  retry: { minHeight: 44, justifyContent: "center", alignSelf: "flex-start", paddingHorizontal: 8 },
  action: { color: theme.peach, fontWeight: "600", fontSize: 14 },
});
