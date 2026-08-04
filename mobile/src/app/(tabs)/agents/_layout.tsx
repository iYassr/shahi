import { Stack } from "expo-router/stack";
import { theme } from "@/lib/theme";

/**
 * A stack per tab, so each tab gets the platform's header — the large title,
 * its collapse on scroll, and correct insets. The status cluster (WAITING,
 * the bell, LIVE) rides in headerRight, set from the screen where that state
 * lives.
 */
export default function AgentsTabLayout() {
  return (
    <Stack
      screenOptions={{
        contentStyle: { backgroundColor: theme.void },
        headerStyle: { backgroundColor: theme.void },
        headerLargeStyle: { backgroundColor: theme.void },
        headerTintColor: theme.peach,
        headerTitleStyle: { color: theme.fg },
        headerLargeTitleStyle: { color: theme.fg },
        headerShadowVisible: false,
        headerLargeTitle: true,
      }}
    >
      <Stack.Screen name="index" options={{ title: "Agents" }} />
    </Stack>
  );
}
