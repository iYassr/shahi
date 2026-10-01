import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/components/text";
import { controlMessage, controlNeedsAttention, updateInProgress } from "@shahi/shared";
import { useSession } from "@/lib/session";
import { theme } from "@/lib/theme";

const CHANNELS = [{ id: "stable", label: "Stable" }, { id: "beta", label: "Beta" }] as const;

export function ComputerUpdate({ settings = false }: { settings?: boolean }) {
  const { control, server } = useSession();
  // What survives is the pairing for a relay computer, the saved login for an
  // SSH one; the card said "pairing" to SSH computers (pre-release bug hunt).
  const kept = server?.startsWith("ssh:") ? "Your SSH login is saved." : "Your pairing is saved.";
  const h = control?.handshake;
  if (!control || !h) return null;
  const busy = control.pending || updateInProgress(h.update.phase);
  // herdr merely stopped is the connection banner's news, beside every other
  // reason nothing can be done; here it would say the same thing twice (see
  // `controlNeedsAttention`).
  if (!settings && !controlNeedsAttention(h, control)) return null;
  const title = h.backend.state.includes("update-required") ? "Update required" : h.update.available ? "Update available" : settings ? "Updates" : "This computer";
  return <View style={[styles.box, settings && styles.group]} accessibilityLiveRegion="polite" testID="computer-update">
    <Text style={styles.title}>{title}</Text>
    <Text style={styles.text}>{control.pending ? "Requesting update…" : control.error ? (updateInProgress(h.update.phase) ? "Reconnecting after the update…" : `Computer unavailable. ${kept}`) : controlMessage(h)}</Text>
    {!!control.error && <Text style={styles.error}>{control.error}</Text>}
    {h.update.managed && <View style={styles.actions}>
      {!!h.update.available && <Pressable accessibilityRole="button" disabled={busy} onPress={() => void control.request("install")} style={styles.button}><Text style={styles.action}>Update computer</Text></Pressable>}
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => void control.request("check")} style={styles.button}><Text style={styles.action}>Check for updates</Text></Pressable>
    </View>}
    {/* One control with two segments, the selected one raised. As two links
        with a tick it read as two actions, "Stable ✓Beta" (device audit,
        build 28). Choosing checks compatibility; it installs nothing. */}
    {settings && h.update.managed && <View style={styles.channel}>
      <Text style={styles.label}>Release channel</Text>
      <View style={styles.segmented} accessibilityLabel="Release channel">
        {CHANNELS.map(({ id, label }) => {
          const on = h.update.channel === id;
          return <Pressable key={id} accessibilityRole="button" accessibilityLabel={`${label} channel`} accessibilityState={{ selected: on, disabled: busy }} disabled={busy}
            onPress={() => { if (!on) void control.request("check", id); }} style={[styles.segment, on && styles.segmentOn]}>
            <Text style={[styles.segmentText, on && styles.segmentTextOn]}>{label}</Text>
          </Pressable>;
        })}
      </View>
      <Text style={styles.text}>Beta gets early releases. Switching to Stable keeps your current release until a compatible update is available.</Text>
    </View>}
  </View>;
}
const styles = StyleSheet.create({
  box: { margin: 16, padding: 16, borderRadius: 14, backgroundColor: theme.surface, gap: 8 },
  // In Settings, one of its inset-grouped sections.
  group: { marginHorizontal: 16, marginTop: 16, marginBottom: 0, borderWidth: 1, borderColor: theme.line, borderCurve: "continuous" },
  title: { color: theme.fg, fontWeight: "600", fontSize: 16 }, text: { color: theme.dim, fontSize: 14 }, error: { color: theme.rose },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 }, button: { minHeight: 44, justifyContent: "center", paddingHorizontal: 8 }, action: { color: theme.peach },
  channel: { gap: 8, marginTop: 4 },
  label: { color: theme.fg, fontSize: 15 },
  segmented: { flexDirection: "row", padding: 3, gap: 3, borderRadius: 10, borderCurve: "continuous", backgroundColor: theme.void, borderWidth: 1, borderColor: theme.line },
  segment: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: 8, borderCurve: "continuous" },
  segmentOn: { backgroundColor: theme.raised, borderWidth: 1, borderColor: theme.lineBright },
  segmentText: { color: theme.dim, fontSize: 14 },
  segmentTextOn: { color: theme.fg, fontWeight: "600" },
});
