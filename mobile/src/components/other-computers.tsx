import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/components/text";
import { useSession } from "@/lib/session";
import { showComputerHome } from "@/lib/navigate";
import { theme } from "@/lib/theme";

/** Keep a way into available work beside the explanation of an unavailable computer. */
export function OtherComputers({ waitingOnly = false }: { waitingOnly?: boolean }) {
  const { computers = [], activeComputerId, switchComputer } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const others = computers.filter(c => c.id !== activeComputerId && (c.available ?? c.link === "live") && (!waitingOnly || !!c.waiting));
  if (!others.length) return null;
  return <View style={styles.list}>
    {others.map(c => <Pressable key={c.id} testID={`open-other-${c.id}`} accessibilityRole="button"
      disabled={!!busy} accessibilityState={{ disabled: !!busy }} style={styles.button} onPress={() => {
        setBusy(c.id); setError("");
        void switchComputer(c.id).then(showComputerHome).catch(e => setError(e.message)).finally(() => setBusy(null));
      }}>
      <Text style={styles.name}>{busy === c.id ? "Opening…" : `Open ${c.name}`}</Text>
      <Text style={styles.detail}>Connected{c.waiting ? ` · ${c.waiting} waiting` : ""}</Text>
    </Pressable>)}
    {!!error && <Text accessibilityRole="alert" style={{ color: theme.rose }}>{error}</Text>}
  </View>;
}
const styles = StyleSheet.create({
  list: { gap: 8 },
  button: { minHeight: 44, padding: 12, gap: 4, borderWidth: 1, borderColor: theme.peach, borderRadius: 10 },
  name: { color: theme.peach, fontSize: 15, fontWeight: "600" },
  detail: { color: theme.fg, fontSize: 13 },
});
