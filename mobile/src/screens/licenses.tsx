/**
 * Open-source licenses: the notices the app's own binary has to carry.
 *
 * Reached from Settings, because that is where iOS apps keep acknowledgements
 * and where a reviewer looks for them. Each notice is shown whole and
 * selectable, never summarised or linked: the licenses ask for their text.
 */
import { ScrollView, StyleSheet, View } from "react-native";
import { Stack } from "expo-router";
import { Text } from "@/components/text";
import { theme } from "@/lib/theme";
import { NOTICES } from "./licenses-text";

export function Licenses() {
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: "Open-source licenses" }} />
      <Text style={styles.intro}>
        Shahi’s SSH connection is built on these libraries. Their licenses ask that the notices below travel with the app.
      </Text>
      {NOTICES.map((notice) => (
        <View key={notice.name} style={styles.notice} testID={`license-${notice.name}`}>
          <Text style={styles.name} accessibilityRole="header">{notice.name} {notice.version}</Text>
          <Text style={styles.meta}>{notice.license}</Text>
          {notice.copyright ? <Text style={styles.meta}>{notice.copyright}</Text> : null}
          <Text style={styles.text} selectable>{notice.text}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.void },
  // Past the home indicator; this screen sits above the tabs, not beside them.
  content: { padding: 16, paddingBottom: 48, gap: 16 },
  intro: { color: theme.dim, fontSize: 14, lineHeight: 20 },
  notice: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.line,
    borderRadius: 14,
    borderCurve: "continuous",
    padding: 14,
    gap: 6,
  },
  name: { color: theme.fg, fontSize: 17, fontWeight: "600" },
  meta: { color: theme.dim, fontSize: 13 },
  text: { color: theme.fg, fontFamily: theme.mono, fontSize: 11, lineHeight: 16, marginTop: 8 },
});
