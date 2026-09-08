import { Pressable, StyleSheet, Text, View } from "react-native";
import { controlMessage, updateInProgress } from "@shahi/shared";
import { useSession } from "@/lib/session";
import { theme } from "@/lib/theme";

export function ComputerUpdate({ settings = false }: { settings?: boolean }) {
  const { control } = useSession();
  const h = control?.handshake;
  if (!control || !h) return null;
  const busy = control.pending || updateInProgress(h.update.phase);
  if (!settings && h.backend.state === "connected" && !h.update.available && !busy && !h.update.message && !control.error) return null;
  return <View style={styles.box} accessibilityLiveRegion="polite" testID="computer-update">
    <Text style={styles.title}>{h.backend.state.includes("update-required") ? "Update required" : h.update.available ? "Update available" : "This computer"}</Text>
    <Text style={styles.text}>{control.pending ? "Requesting update…" : control.error ? (updateInProgress(h.update.phase) ? "Reconnecting after the update…" : "Computer unavailable. Your pairing is saved.") : controlMessage(h)}</Text>
    {!!control.error && <Text style={styles.error}>{control.error}</Text>}
    {h.update.managed && <View style={styles.actions}>
      {!!h.update.available && <Pressable accessibilityRole="button" disabled={busy} onPress={() => void control.request("install")} style={styles.button}><Text style={styles.action}>Update computer</Text></Pressable>}
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => void control.request("check")} style={styles.button}><Text style={styles.action}>Check for updates</Text></Pressable>
    </View>}
    {settings && h.update.managed && <View style={styles.actions}>
      {(["stable", "beta"] as const).map(channel => <Pressable key={channel} accessibilityRole="button" accessibilityState={{ selected: h.update.channel === channel, disabled: busy }} disabled={busy} onPress={() => void control.request("check", channel)} style={styles.button}><Text style={styles.action}>{h.update.channel === channel ? "✓ " : ""}{channel === "stable" ? "Stable" : "Beta"}</Text></Pressable>)}
      <Text style={styles.text}>Beta gets early releases. Switching to Stable keeps your current release until a compatible update is available.</Text>
    </View>}
  </View>;
}
const styles = StyleSheet.create({
  box: { margin: 16, padding: 16, borderRadius: 14, backgroundColor: theme.surface, gap: 8 },
  title: { color: theme.fg, fontWeight: "600", fontSize: 16 }, text: { color: theme.dim, fontSize: 14 }, error: { color: theme.rose },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 }, button: { minHeight: 44, justifyContent: "center", paddingHorizontal: 8 }, action: { color: theme.peach },
});
