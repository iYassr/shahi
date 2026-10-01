import { useState } from "react";
import { Alert, View, Pressable, ScrollView, StyleSheet, TextInput } from "react-native";
import { Text } from "@/components/text";
import { Icon } from "@/components/icons";
import { resetTo, showComputerHome } from "@/lib/navigate";
import { useSession } from "@/lib/session";
import { theme } from "@/lib/theme";

/**
 * The computers this phone is paired with. Each card opens that computer's
 * agents; renaming and revoking sit behind its "•••" button. They were loose
 * links under every card, and the red "Revoke this phone’s access" one tap
 * below the card you meant to open (device audit, build 28).
 */
export function Computers() {
  const { computers, activeComputerId, connected, switchComputer, addComputer, revokeComputer, renameComputer, accessEnded } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [name, setName] = useState("");
  async function choose(id: string) {
    if (busy) return;
    setBusy(id); setError(null);
    try { await switchComputer(id); showComputerHome(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }
  const actingOn = computers.find(c => c.id === acting);
  return <View style={styles.screen}>
    <ScrollView contentContainerStyle={styles.content}>
    {accessEnded && <Text accessibilityRole="alert" testID="access-ended" style={styles.ended}>{accessEnded}</Text>}
    <Text style={styles.note}>All your computers stay connected while Shahi is open. Choose one to view its agents.</Text>
    {computers.map((computer) => {
      const selected = connected && computer.id === activeComputerId;
      const available = computer.available ?? computer.link === "live";
      const status = computer.status ?? (computer.link === "live" ? "Connected" : computer.link === "lost" ? "Offline · retrying" : "Connecting…");
      const waiting = computer.waiting ? ` · ${computer.waiting} waiting${available ? "" : " (last known)"}` : "";
      return <View key={computer.id} style={[styles.card, selected && styles.selected]}>
        <View style={styles.cardTop}>
          <Pressable testID={`computer-${computer.id}`} accessibilityRole="button"
            accessibilityLabel={`${selected ? "Current computer" : "Switch to"} ${computer.name}, ${status}${waiting}, ${computer.address}`}
            accessibilityState={{ selected, disabled: !!busy }} disabled={!!busy}
            onPress={() => void choose(computer.id)} style={styles.cardMain}>
            <Text style={styles.name}>{computer.name}</Text>
            <Text style={[styles.status, { color: available ? theme.mint : theme.peach }]}>{status}{waiting}</Text>
            <Text style={styles.address} numberOfLines={1}>{computer.address}</Text>
            <Text style={selected ? styles.viewing : styles.action}>{busy === computer.id ? "Opening…" : selected ? "✓ Viewing" : "Open agents"}</Text>
          </Pressable>
          <Pressable testID={`computer-actions-${computer.id}`} accessibilityRole="button" accessibilityLabel={`More for ${computer.name}`}
            style={styles.more} onPress={() => setActing(computer.id)}>
            <Text style={styles.moreText}>•••</Text>
          </Pressable>
        </View>
        {renaming === computer.id && <View style={styles.rename}>
          <TextInput accessibilityLabel="Computer name" value={name} onChangeText={setName} maxLength={80} style={styles.input} autoFocus returnKeyType="done" />
          <View style={styles.renameActions}>
            <Pressable accessibilityRole="button" style={styles.button} disabled={!!busy || !name.trim()} onPress={() => {
              setBusy(computer.id); setError(null);
              void renameComputer(computer.id, name).then(() => setRenaming(null)).catch(e => setError(e.message)).finally(() => setBusy(null));
            }}><Text style={styles.action}>Save name</Text></Pressable>
            <Pressable accessibilityRole="button" style={styles.button} onPress={() => setRenaming(null)}><Text style={styles.note}>Cancel</Text></Pressable>
          </View>
        </View>}
      </View>;
    })}
    {computers.length === 0 && <Text style={styles.note}>No saved computers yet. Pair one to get started.</Text>}
    {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    <Pressable testID="add-computer" accessibilityRole="button" disabled={!!busy} style={styles.add} onPress={() => {
      setBusy("add"); setError(null);
      void addComputer().then(() => resetTo("/connect")).catch((e: Error) => setError(e.message)).finally(() => setBusy(null));
    }}><Text style={styles.action}>Add a computer</Text></Pressable>
    <Text style={styles.note}>Previously replaced or signed-out connections need a new pairing code once. “Devices with access” in Settings manages phones and browsers allowed into the current computer.</Text>
    </ScrollView>
    {/* The same in-app sheet as an agent's long press (see agents.tsx for why
        not ActionSheetIOS or Modal). */}
    {actingOn && <View style={styles.sheetLayer}>
      <Pressable accessibilityRole="button" accessibilityLabel="Dismiss actions" style={styles.sheetBack} onPress={() => setActing(null)} />
      <View style={styles.sheetCard}>
        <Text style={styles.sheetTitle} numberOfLines={1}>{actingOn.name}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={`Rename ${actingOn.name}`} style={styles.sheetItem} onPress={() => {
          setName(actingOn.name); setRenaming(actingOn.id); setActing(null);
        }}><Icon name="server" color={theme.peach} size={16} /><Text style={styles.sheetItemText}>Rename</Text></Pressable>
        {actingOn.kind === "relay" && <Pressable accessibilityRole="button" testID={`revoke-computer-${actingOn.id}`} style={styles.sheetItem} onPress={() => {
          setActing(null);
          Alert.alert(`Revoke this phone’s access to ${actingOn.name}?`, `This phone will need a new pairing code for ${actingOn.name}. Other computers stay connected.`, [
            { text: "Cancel", style: "cancel" }, { text: "Revoke access", style: "destructive", onPress: () => { void revokeComputer(actingOn.id).catch(e => setError(e.message)); } },
          ]);
        }}><Icon name="log-out" color={theme.rose} size={16} /><Text style={[styles.sheetItemText, { color: theme.rose }]}>Revoke this phone’s access</Text></Pressable>}
        <Pressable accessibilityRole="button" style={styles.sheetItem} onPress={() => setActing(null)}>
          <Text style={[styles.sheetItemText, { color: theme.dim }]}>Cancel</Text>
        </Pressable>
      </View>
    </View>}
  </View>;
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.void },
  content: { padding: 20, paddingBottom: 100, gap: 14, backgroundColor: theme.void },
  card: { backgroundColor: theme.surface, borderColor: theme.line, borderWidth: 1, borderRadius: 14, borderCurve: "continuous" },
  selected: { borderColor: theme.fg },
  cardTop: { flexDirection: "row", alignItems: "flex-start" },
  cardMain: { flex: 1, padding: 16, gap: 6 },
  more: { minWidth: 48, minHeight: 48, alignItems: "center", justifyContent: "center", marginTop: 4, marginRight: 4 },
  moreText: { color: theme.dim, fontSize: 16, letterSpacing: 1 },
  name: { color: theme.fg, fontSize: 18, fontWeight: "600" },
  status: { fontSize: 15, fontWeight: "500" },
  address: { color: theme.dim, fontFamily: theme.mono, fontSize: 11 },
  viewing: { color: theme.dim, fontSize: 14, marginTop: 4 },
  action: { color: theme.peach, fontSize: 16, fontWeight: "600" },
  rename: { paddingHorizontal: 16, paddingBottom: 12, gap: 4 },
  renameActions: { flexDirection: "row", gap: 8 },
  input: { color: theme.fg, fontSize: 17, minHeight: 44, borderBottomWidth: 1, borderBottomColor: theme.lineBright },
  button: { minHeight: 44, justifyContent: "center", paddingHorizontal: 12 },
  add: { backgroundColor: theme.surface, borderColor: theme.line, borderWidth: 1, borderRadius: 14, borderCurve: "continuous", padding: 16, minHeight: 52, justifyContent: "center" },
  note: { color: theme.dim, fontSize: 13, lineHeight: 19 },
  error: { color: theme.rose, fontSize: 14 },
  ended: { color: theme.fg, fontSize: 15, lineHeight: 21, backgroundColor: theme.surface, borderColor: theme.peach, borderWidth: 1, borderRadius: 14, padding: 16 },
  sheetLayer: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, justifyContent: "flex-end" },
  sheetBack: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.55)" },
  sheetCard: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.line, borderRadius: 16, borderCurve: "continuous", marginHorizontal: 10, marginBottom: 40, padding: 16, gap: 4 },
  sheetTitle: { color: theme.dim, fontSize: 12, marginBottom: 8 },
  sheetItem: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 48 },
  sheetItemText: { color: theme.fg, fontSize: 16 },
});
