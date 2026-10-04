import { UiText } from "@/components/ui-text";
import { useI18n } from "@/lib/i18n";
import { Alert, Linking, Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Text } from "@/components/text";
import { theme } from "@/lib/theme";

/**
 * The footer links. `licenses` adds the open-source notices, for the Connect
 * screen: Settings has its own row, but only after a computer is connected,
 * and the app carries those notices whether or not one ever is.
 */
export function PrivacyLinks({ licenses = false }: { licenses?: boolean }) {
  const { t: ui } = useI18n();
  const open = (url: string) => {
    void Linking.openURL(url).catch(() => Alert.alert(ui("Couldn't open link"), ui("Visit getshahi.dev/privacy or email support@getshahi.dev.")));
  };
  return <View style={styles.links}>
    <Pressable accessibilityRole="link" onPress={() => open("https://getshahi.dev/privacy")} style={styles.link}>
      <UiText style={styles.text}>Privacy policy</UiText>
    </Pressable>
    <Pressable accessibilityRole="link" onPress={() => open("mailto:support@getshahi.dev")} style={styles.link}>
      <UiText style={styles.text}>Get help</UiText>
    </Pressable>
    {licenses && <Pressable accessibilityRole="link" onPress={() => router.push("/licenses")} style={styles.link} testID="licenses-link">
      <UiText style={styles.text}>Open-source licenses</UiText>
    </Pressable>}
  </View>;
}

const styles = StyleSheet.create({
  links: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 12, paddingVertical: 8 },
  link: { minHeight: 44, paddingHorizontal: 8, justifyContent: "center" },
  text: { color: theme.peach, fontSize: 14 },
});
