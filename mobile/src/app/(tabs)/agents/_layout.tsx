import { useI18n } from "@/lib/i18n";
import { Stack } from "expo-router/stack";
import { theme } from "@/lib/theme";

/**
 * A stack per tab, so each tab gets the platform's header — the large title,
 * its collapse on scroll, and correct insets. The status cluster (WAITING,
 * the bell, LIVE) rides in headerRight, set from the screen where that state
 * lives.
 */
export default function AgentsTabLayout() {
  const { t: ui } = useI18n();
  return (
    <Stack
      screenOptions={{
        contentStyle: { backgroundColor: theme.void },
        headerStyle: { backgroundColor: theme.void },
        headerLargeStyle: { backgroundColor: theme.void },
        headerTintColor: theme.fg,
        headerTitleStyle: { color: theme.fg },
        headerLargeTitleStyle: { color: theme.fg },
        headerShadowVisible: false,
        headerLargeTitle: true,
      }}
    >
      <Stack.Screen name="index" options={{ title: ui("Agents") }} />
    </Stack>
  );
}
