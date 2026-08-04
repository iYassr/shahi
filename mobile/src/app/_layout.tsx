import { Stack } from "expo-router/stack";
import { StatusBar } from "expo-status-bar";
import { SessionProvider } from "@/lib/session";
import { theme } from "@/lib/theme";

/**
 * The root stack: a gate, the tabs, and a pane pushed on top.
 *
 * `connect` is a route rather than a branch inside the first screen, so the
 * tabs are never constructed before there is a session to fill them — a native
 * tab bar that appears and then has nothing behind it is worse than one that
 * arrives a moment later.
 */
export default function RootLayout() {
  return (
    // Above the router, so the mirror and the socket survive navigation.
    <SessionProvider>
      <Stack
        screenOptions={{
          contentStyle: { backgroundColor: theme.void },
          headerStyle: { backgroundColor: theme.void },
          headerTintColor: theme.peach,
          headerTitleStyle: { color: theme.fg },
          headerShadowVisible: false,
          // The back button shows the chevron alone. A stack this shallow gains
          // nothing from repeating the previous screen's title beside it.
          headerBackButtonDisplayMode: "minimal",
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="connect" options={{ headerShown: false }} />
        {/* The Pane component draws its own header; without this the default
            stack header sat above it showing the raw route name. */}
        <Stack.Screen name="pane/[paneId]" options={{ headerShown: false }} />
      </Stack>
      <StatusBar style="light" />
    </SessionProvider>
  );
}
