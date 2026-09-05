import { Stack } from "expo-router/stack";
import { theme } from "@/lib/theme";

/** Same shape as the Agents tab's layout — see the note there. */
export default function SpacesTabLayout() {
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
      <Stack.Screen name="index" options={{ title: "Spaces" }} />
    </Stack>
  );
}
