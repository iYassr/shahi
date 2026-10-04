import { theme } from "../../lib/theme";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { useI18n } from "@/lib/i18n";

/**
 * The real tab bar, not a drawn one.
 *
 * This was two `Pressable`s with a line under the active label — fine on the
 * web, and on a phone the clearest tell that a screen is not an app. A native
 * tab bar brings the things you cannot reproduce: the blur behind it, the
 * selection haptic, the scroll-to-top on a second tap of the active tab, and
 * on iOS 26 the way it collapses as you scroll.
 *
 * SF Symbols rather than glyphs here, deliberately, and only here: the status
 * marks in a list stay `○ ◐ ✓` because they are the terminal's own vocabulary
 * and this app is a window onto a terminal. Chrome is the app's own voice, and
 * the app's own voice should be the platform's.
 */
export default function TabLayout() {
  const { t } = useI18n();
  return (
    <NativeTabs tintColor={theme.fg}>
      <NativeTabs.Trigger name="agents" accessibilityLabel={t("Agents")}>
        <NativeTabs.Trigger.Icon sf="cpu" md="memory" />
        <NativeTabs.Trigger.Label>{t("Agents")}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="spaces" accessibilityLabel={t("Spaces")}>
        <NativeTabs.Trigger.Icon sf={{ default: "folder", selected: "folder.fill" }} md="folder" />
        <NativeTabs.Trigger.Label>{t("Spaces")}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings" accessibilityLabel={t("Settings")}>
        <NativeTabs.Trigger.Icon sf="gearshape" md="settings" />
        <NativeTabs.Trigger.Label>{t("Settings")}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
