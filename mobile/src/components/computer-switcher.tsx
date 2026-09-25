import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "@/components/text";
import { router } from "expo-router";
import { showComputerHome } from "@/lib/navigate";
import { useSession } from "@/lib/session";
import { theme } from "@/lib/theme";

export function ComputerSwitcher() {
  const { computers, activeComputerId, session, switchComputer } = useSession();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const current = computers.find(c => c.id === activeComputerId);
  const name = session?.serverName || current?.name || "Computers";
  return <>
    {/* A navigation-bar item, sized like one. The bar does not grow with
        Dynamic Type, so at AX5 the name scaled to 53pt inside a fixed
        190pt slot and read "stub-…" beside a LIVE that stays capped
        (September 2026 review). Capped the same way, and a long press shows
        the name full size, which is how iOS bar items serve large text. */}
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Switch computer"
      accessibilityValue={{ text: name }}
      accessibilityShowsLargeContentViewer
      accessibilityLargeContentTitle={name}
      testID="computer-switcher"
      onPress={() => setOpen(true)}
      style={styles.trigger}
    >
      <Text numberOfLines={1} style={styles.title} maxFontSizeMultiplier={1.2}>{name} ▾</Text>
    </Pressable>
    <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
      <View style={styles.overlay}><View style={styles.sheet}>
        <Text style={styles.title}>Computers</Text>
        <ScrollView>
          {computers.map(c => <Pressable key={c.id} accessibilityRole="button" testID={`quick-computer-${c.id}`} style={styles.row} onPress={() => {
            void switchComputer(c.id).then(() => { setOpen(false); showComputerHome(); }).catch(e => setError(e.message));
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
