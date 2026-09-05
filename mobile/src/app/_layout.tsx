import { Stack } from "expo-router/stack";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SessionProvider } from "@/lib/session";
import { ErrorBoundary } from "@/components/error-boundary";
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
    // The gesture root is what lets a row's swipe actions receive the drag.
    <GestureHandlerRootView style={{ flex: 1 }}>
    <ErrorBoundary>
    <SessionProvider>
      <Stack
        screenOptions={{
          contentStyle: { backgroundColor: theme.void },
          headerStyle: { backgroundColor: theme.void },
          headerTintColor: theme.fg,
          headerTitleStyle: { color: theme.fg },
          headerShadowVisible: false,
          // The back button shows the chevron alone. A stack this shallow gains
          // nothing from repeating the previous screen's title beside it.
          headerBackButtonDisplayMode: "minimal",
          // What the hidden label reads as — otherwise VoiceOver (and the test
          // driver) get the previous ROUTE'S name, which is "(tabs)".
          headerBackTitle: "Back",
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="connect" options={{ headerShown: false }} />
        {/* Titles set from inside the screens, where the pane or space is
            known. The empty defaults stop raw route names flashing first. */}
        <Stack.Screen name="pane/[paneId]" options={{ title: "" }} />
        <Stack.Screen name="space/[workspaceId]" options={{ title: "" }} />
        {/* Real sheets: the presentation owns the card, the dimming,
            drag-to-dismiss and staying clear of the keyboard — all things the
            old absolutely-positioned sheet had to fake. */}
        <Stack.Screen
          name="new-space"
          options={{
            presentation: "formSheet",
            headerShown: false,
            sheetAllowedDetents: "fitToContents",
            sheetGrabberVisible: true,
            contentStyle: { backgroundColor: theme.surface },
          }}
        />
        <Stack.Screen
          name="new-agent"
          options={{
            presentation: "formSheet",
            headerShown: false,
            sheetAllowedDetents: "fitToContents",
            sheetGrabberVisible: true,
            contentStyle: { backgroundColor: theme.surface },
          }}
        />
      </Stack>
      <StatusBar style="light" />
    </SessionProvider>
    </ErrorBoundary>
    </GestureHandlerRootView>
  );
}
