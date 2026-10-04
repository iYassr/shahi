import { UiText } from "@/components/ui-text";
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/components/text";
import { useSession } from "@/lib/session";
import { theme } from "@/lib/theme";

/**
 * The Keychain would not keep the saved computers: said as that, and never as
 * a connection problem. The computer is still connected and the header still
 * says LIVE, because both are true; what is at risk is the next launch. On an
 * unsigned build 32 this was shown as NOT RESPONDING and "Reconnecting to
 * Mac…" while the Computers menu said Connected, and the pairing was gone
 * after the app closed.
 */
export function SaveProblem() {
  const { saveError, retrySave } = useSession();
  const [busy, setBusy] = useState(false);
  if (!saveError) return null;
  return <View style={styles.card} accessibilityLiveRegion="polite" testID="save-problem">
    <Text style={styles.title}>{saveError.message}</Text>
    <UiText style={styles.detail}>Your computers work now, but may not be here after you close Shahi.</UiText>
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy} style={styles.retry} testID="retry-save"
      onPress={() => { setBusy(true); void retrySave().catch(() => {}).finally(() => setBusy(false)); }}>
      <UiText style={styles.action}>{busy ? "Saving…" : "Try again"}</UiText>
    </Pressable>
  </View>;
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 16, marginVertical: 8, padding: 14, gap: 6, backgroundColor: theme.surface, borderColor: theme.line, borderWidth: 1, borderRadius: 12 },
  title: { color: theme.peach, fontWeight: "600", fontSize: 15 },
  detail: { color: theme.fg, fontSize: 14, lineHeight: 20 },
  retry: { minHeight: 44, justifyContent: "center", alignSelf: "flex-start", paddingHorizontal: 8 },
  action: { color: theme.peach, fontWeight: "600", fontSize: 14 },
});
