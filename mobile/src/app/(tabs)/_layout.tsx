import { NativeTabs } from "expo-router/unstable-native-tabs";

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
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon sf="cpu" md="memory" />
        <NativeTabs.Trigger.Label>Agents</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="spaces">
        <NativeTabs.Trigger.Icon sf="square.grid.2x2" md="grid_view" />
        <NativeTabs.Trigger.Label>Spaces</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
