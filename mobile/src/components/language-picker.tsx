import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { SUPPORTED_LOCALES, type LocalePreference } from "@shahi/shared";
import { useI18n } from "@/lib/i18n";
import { Text } from "./text";
import { UiText } from "./ui-text";
import { theme } from "@/lib/theme";

export function LanguagePicker() {
  const { preference, direction, setPreference, t } = useI18n();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const choose = async (value: LocalePreference) => {
    setSaving(true); setFailed(false);
    try { await setPreference(value); } catch { setFailed(true); } finally { setSaving(false); }
  };
  return <View style={[styles.body, { direction }]} testID="language-picker">
    <UiText accessibilityRole="header" style={styles.label}>Language</UiText>
    <View style={styles.options}>
      {[{ locale: "system" as const, label: t("Use device language") }, ...SUPPORTED_LOCALES].map(option => <Pressable
        key={option.locale} accessibilityRole="radio" accessibilityLabel={option.label}
        accessibilityState={{ checked: preference === option.locale, disabled: saving }} disabled={saving}
        onPress={() => void choose(option.locale)} testID={`language-${option.locale}`}
        style={[styles.option, preference === option.locale && styles.selected]}>
        <Text style={styles.text}>{option.label}</Text>
      </Pressable>)}
    </View>
    {failed && <UiText accessibilityRole="alert" style={styles.error}>Couldn't save language. Try again.</UiText>}
  </View>;
}
const styles = StyleSheet.create({
  body: { padding: 12, gap: 8 }, label: { color: theme.fg, fontSize: 15 },
  options: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  option: { minHeight: 44, paddingHorizontal: 12, justifyContent: "center", borderRadius: 10, borderWidth: 1, borderColor: theme.line },
  selected: { backgroundColor: theme.raised, borderColor: theme.peach },
  text: { color: theme.fg, fontSize: 14 }, error: { color: theme.peach, fontSize: 13 },
});
