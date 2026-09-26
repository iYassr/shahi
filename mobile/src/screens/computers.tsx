import { useState } from "react";
import { Alert, View, Pressable, ScrollView, StyleSheet, TextInput } from "react-native";
import { Text } from "@/components/text";
import { resetTo, showComputerHome } from "@/lib/navigate";
import { useSession } from "@/lib/session";
import { theme } from "@/lib/theme";

export function Computers() {
  const { computers, activeComputerId, connected, switchComputer, addComputer, revokeComputer, renameComputer, accessEnded } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");
  async function choose(id: string) {
    if (busy) return;
    setBusy(id); setError(null);
    try { await switchComputer(id); showComputerHome(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }
  return <ScrollView contentContainerStyle={styles.content}>
    {accessEnded && <Text accessibilityRole="alert" testID="access-ended" style={styles.ended}>{accessEnded}</Text>}
    <Text style={styles.note}>All your computers stay connected while Shahi is open. Choose one to view its agents.</Text>
    {computers.map((computer) => {
      const selected = connected && computer.id === activeComputerId;
      return <View key={computer.id}><Pressable testID={`computer-${computer.id}`} accessibilityRole="button"
        accessibilityLabel={`${selected ? "Current computer" : "Switch to"} ${computer.name}, ${computer.address}`}
        accessibilityState={{ selected, disabled: !!busy }} disabled={!!busy}
        onPress={() => void choose(computer.id)} style={[styles.card, selected && styles.selected]}>
        <Text style={styles.name}>{computer.name}</Text>
        <Text style={styles.note}>{computer.address}</Text>
        <Text style={[styles.note, { color: (computer.available ?? computer.link === "live") ? theme.mint : theme.peach }]}>{computer.status ?? (computer.link === "live" ? "Connected" : computer.link === "lost" ? "Offline · retrying" : "Connecting…")}{computer.waiting ? ` · ${computer.waiting} waiting${(computer.available ?? computer.link === "live") ? "" : " (last known)"}` : ""}</Text>
        <Text style={selected ? styles.note : styles.action}>{busy === computer.id ? "Opening…" : selected ? "✓ Viewing" : "Open agents"}</Text>
      </Pressable>
      {renaming === computer.id ? <View style={styles.card}>
        <TextInput accessibilityLabel="Computer name" value={name} onChangeText={setName} maxLength={80} style={styles.name} autoFocus returnKeyType="done" />
        <Pressable accessibilityRole="button" style={styles.button} disabled={!!busy || !name.trim()} onPress={() => {
          setBusy(computer.id); setError(null);
          void renameComputer(computer.id, name).then(() => setRenaming(null)).catch(e => setError(e.message)).finally(() => setBusy(null));
        }}><Text style={styles.action}>Save name</Text></Pressable>
        <Pressable accessibilityRole="button" style={styles.button} onPress={() => setRenaming(null)}><Text style={styles.note}>Cancel</Text></Pressable>
      </View> : <Pressable accessibilityRole="button" accessibilityLabel={`Rename ${computer.name}`} style={styles.button} onPress={() => { setName(computer.name); setRenaming(computer.id); }}><Text style={styles.action}>Rename</Text></Pressable>}
      {computer.kind === "relay" && <Pressable accessibilityRole="button" testID={`revoke-computer-${computer.id}`} style={{ padding: 12 }} onPress={() => Alert.alert("Revoke this phone’s access?", `This phone will need a new pairing code for ${computer.name}. Other computers stay connected.`, [
        { text: "Cancel", style: "cancel" }, { text: "Revoke access", style: "destructive", onPress: () => { void revokeComputer(computer.id).catch(e => setError(e.message)); } },
      ])}><Text style={styles.error}>Revoke this phone’s access</Text></Pressable>}
      </View>;
    })}
    {computers.length === 0 && <Text style={styles.note}>No saved computers yet. Pair one to get started.</Text>}
    {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    <Pressable testID="add-computer" accessibilityRole="button" disabled={!!busy} style={styles.card} onPress={() => {
      setBusy("add"); setError(null);
      void addComputer().then(() => resetTo("/connect")).catch((e: Error) => setError(e.message)).finally(() => setBusy(null));
    }}><Text style={styles.action}>Add a computer</Text></Pressable>
    <Text style={styles.note}>Previously replaced or signed-out connections need a new pairing code once. “Devices with access” in Settings manages phones and browsers allowed into the current computer.</Text>
  </ScrollView>;
}
const styles = StyleSheet.create({
  content: { padding: 20, paddingBottom: 100, gap: 14, backgroundColor: theme.void },
  card: { backgroundColor: theme.surface, borderColor: theme.line, borderWidth: 1, borderRadius: 14, padding: 16, gap: 8 },
  selected: { borderColor: theme.fg },
  button: { minHeight: 44, justifyContent: "center", padding: 12 },
  name: { color: theme.fg, fontSize: 18, fontWeight: "600" },
  note: { color: theme.dim, fontSize: 13, lineHeight: 19 },
  action: { color: theme.peach, fontSize: 16, fontWeight: "600" },
  error: { color: theme.rose, fontSize: 14 },
  ended: { color: theme.fg, fontSize: 15, lineHeight: 21, backgroundColor: theme.surface, borderColor: theme.peach, borderWidth: 1, borderRadius: 14, padding: 16 },
});
