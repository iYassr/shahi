import { Alert, Linking, Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/components/text";
import { theme } from "@/lib/theme";

export function PrivacyLinks() {
  const open = (url: string) => {
    void Linking.openURL(url).catch(() => Alert.alert("Couldn't open link", "Visit getshahi.dev/privacy or email support@getshahi.dev."));
  };
  return <View style={styles.links}>
    <Pressable accessibilityRole="link" onPress={() => open("https://getshahi.dev/privacy")} style={styles.link}>
      <Text style={styles.text}>Privacy policy</Text>
    </Pressable>
    <Pressable accessibilityRole="link" onPress={() => open("mailto:support@getshahi.dev")} style={styles.link}>
      <Text style={styles.text}>Get help</Text>
    </Pressable>
  </View>;
}

const styles = StyleSheet.create({
  links: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 12, paddingVertical: 8 },
  link: { minHeight: 44, paddingHorizontal: 8, justifyContent: "center" },
  text: { color: theme.peach, fontSize: 14 },
});
