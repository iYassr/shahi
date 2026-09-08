import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useSession } from "@/lib/session";
import { theme } from "@/lib/theme";

export function ComputerSwitcher() {
  const { computers, activeComputerId, session, switchComputer } = useSession();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const current = computers.find(c => c.id === activeComputerId);
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel="Switch computer" testID="computer-switcher" onPress={() => setOpen(true)} style={styles.trigger}>
      <Text numberOfLines={1} style={styles.title}>{session?.serverName || current?.name || "Computers"} ▾</Text>
    </Pressable>
    <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
      <View style={styles.overlay}><View style={styles.sheet}>
        <Text style={styles.title}>Computers</Text>
        <ScrollView>
          {computers.map(c => <Pressable key={c.id} accessibilityRole="button" testID={`quick-computer-${c.id}`} style={styles.row} onPress={() => {
            void switchComputer(c.id).then(() => { setOpen(false); router.replace("/"); }).catch(e => setError(e.message));
          }}>
            <Text style={styles.title}>{c.id === activeComputerId ? "✓ " : ""}{c.name}</Text>
            <Text style={{ color: theme.dim, fontSize: 12 }}>{c.address}</Text>
            <Text style={{ color: c.link === "live" ? theme.mint : theme.dim }}>{c.link === "live" ? "Connected" : c.link === "lost" ? "Offline · retrying" : "Connecting…"}</Text>
          </Pressable>)}
        </ScrollView>
        {!!error && <Text style={{ color: theme.rose }}>{error}</Text>}
        <Pressable accessibilityRole="button" style={styles.row} onPress={() => { setOpen(false); router.push("/computers"); }}><Text style={styles.action}>Manage computers</Text></Pressable>
        <Pressable accessibilityRole="button" style={styles.row} onPress={() => setOpen(false)}><Text style={styles.action}>Close</Text></Pressable>
      </View></View>
    </Modal>
  </>;
}
const styles = StyleSheet.create({
  trigger: { minHeight: 44, justifyContent: "center", flexShrink: 1, maxWidth: 190 },
  title: { color: theme.fg, fontSize: 17, fontWeight: "600" },
  overlay: { flex: 1, backgroundColor: "#0009", justifyContent: "center", padding: 24 },
  sheet: { maxHeight: "80%", backgroundColor: theme.surface, borderRadius: 18, padding: 20 },
  row: { paddingVertical: 14, gap: 5 }, action: { color: theme.peach, fontSize: 16 },
});
