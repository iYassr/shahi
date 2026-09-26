import { useCallback, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "@/components/text";
import { router, useFocusEffect } from "expo-router";
import { showComputerHome } from "@/lib/navigate";
import { useSession } from "@/lib/session";
import { theme } from "@/lib/theme";

export function ComputerSwitcher() {
  const { computers, activeComputerId, session, switchComputer } = useSession();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  // A Modal is presented above the whole stack, not inside this screen, so it
  // stayed on top of a pane a notification tap had pushed, until Close was
  // tapped (pre-release bug hunt). Whatever takes this screen's place closes it.
  useFocusEffect(useCallback(() => () => setOpen(false), []));
  const current = computers.find(c => c.id === activeComputerId);
  const name = current?.name || session?.serverName || "Computers";
  const waitingElsewhere = computers.filter(c => c.id !== activeComputerId && (c.available ?? c.link === "live")).reduce((sum, c) => sum + (c.waiting ?? 0), 0);
  return <>
    {/* A navigation-bar item, sized like one. The bar does not grow with
        Dynamic Type, so at AX5 the name scaled to 53pt inside a fixed
        190pt slot and read "stub-…" beside a LIVE that stays capped
        (September 2026 review). Capped the same way, and a long press shows
        the name full size, which is how iOS bar items serve large text. */}
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Switch computer"
      accessibilityValue={{ text: `${name}${waitingElsewhere ? `, ${waitingElsewhere} waiting on other computers` : ""}` }}
      accessibilityShowsLargeContentViewer
      accessibilityLargeContentTitle={name}
      testID="computer-switcher"
      onPress={() => setOpen(true)}
      style={styles.trigger}
    >
      <Text numberOfLines={1} style={styles.title} maxFontSizeMultiplier={1.2}>{name} ▾</Text>
      {waitingElsewhere > 0 && <Text testID="other-computers-waiting" style={styles.waiting} maxFontSizeMultiplier={1.2}>{waitingElsewhere}</Text>}
    </Pressable>
    <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
      <View style={styles.overlay}><View style={styles.sheet}>
        <Text style={styles.title}>Computers</Text>
        <ScrollView style={{ flexShrink: 1 }}>
          {computers.map(c => {
            const status = c.status ?? (c.link === "live" ? "Connected" : c.link === "lost" ? "Offline · retrying" : "Connecting…");
            const waiting = c.waiting ? ` · ${c.waiting} waiting${(c.available ?? c.link === "live") ? "" : " (last known)"}` : "";
            // Which one is current is a state, said as one; the tick is for
            // the eye. Read from the row's text it was "check mark, stub-box"
            // with no selected trait (pre-release bug hunt).
            return <Pressable key={c.id} accessibilityRole="button" accessibilityLabel={`${c.name}, ${c.address}, ${status}${waiting}`}
              accessibilityState={{ selected: c.id === activeComputerId }} testID={`quick-computer-${c.id}`} style={styles.row} onPress={() => {
              void switchComputer(c.id).then(() => { setOpen(false); showComputerHome(); }).catch(e => setError(e.message));
            }}>
              <Text style={styles.title}>{c.id === activeComputerId ? "✓ " : ""}{c.name}</Text>
              <Text style={{ color: theme.dim, fontSize: 12 }}>{c.address}</Text>
              <Text style={{ color: (c.available ?? c.link === "live") ? theme.mint : theme.peach }}>{status}{waiting}</Text>
            </Pressable>;
          })}
        </ScrollView>
        {!!error && <Text style={{ color: theme.rose }}>{error}</Text>}
        <Pressable accessibilityRole="button" style={styles.row} onPress={() => { setOpen(false); router.push("/computers"); }}><Text style={styles.action}>Manage computers</Text></Pressable>
        <Pressable accessibilityRole="button" style={styles.row} onPress={() => setOpen(false)}><Text style={styles.action}>Close</Text></Pressable>
      </View></View>
    </Modal>
  </>;
}
const styles = StyleSheet.create({
  trigger: { minHeight: 44, alignItems: "center", flexDirection: "row", gap: 5, flexShrink: 1, maxWidth: 190 },
  waiting: { color: theme.peach, fontSize: 12, fontWeight: "600" },
  title: { color: theme.fg, fontSize: 17, fontWeight: "600" },
  overlay: { flex: 1, backgroundColor: "#0009", justifyContent: "center", padding: 24 },
  sheet: { maxHeight: "80%", backgroundColor: theme.surface, borderRadius: 18, padding: 20 },
  row: { minHeight: 44, justifyContent: "center", paddingVertical: 14, gap: 5 }, action: { color: theme.peach, fontSize: 16 },
});
