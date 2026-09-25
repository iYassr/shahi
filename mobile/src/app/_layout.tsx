import { TypographyProvider } from "@/components/text";
import { useEffect, useRef, useState } from "react";
import { router, ThemeProvider } from "expo-router";
import { onNotificationTapped, showNotificationsWhileOpen } from "@/lib/push";
import { openPane, showComputerHome } from "@/lib/navigate";
import { Stack } from "expo-router/stack";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SessionProvider, useSession } from "@/lib/session";
import { ErrorBoundary } from "@/components/error-boundary";
import { theme } from "@/lib/theme";
import { navigationTheme } from "@/lib/navigation-theme";

/**
 * The root stack: a gate, the tabs, and a pane pushed on top.
 *
 * `connect` is a route rather than a branch inside the first screen, so the
 * tabs are never constructed before there is a session to fill them — a native
 * tab bar that appears and then has nothing behind it is worse than one that
 * arrives a moment later.
 */
export default function RootLayout() {
  // Not behind `ready` or Settings: a notification can arrive in the first
  // second of a launch, on any screen, for a phone that opted in long ago.
  useEffect(() => { showNotificationsWhileOpen(); }, []);
  return (
    // Above the router, so the mirror and the socket survive navigation.
    // The gesture root is what lets a row's swipe actions receive the drag.
    <GestureHandlerRootView style={{ flex: 1 }}>
    <ErrorBoundary>
    <TypographyProvider>
    <ThemeProvider value={navigationTheme}>
      <SessionProvider>
        <Navigation />
      </SessionProvider>
    </ThemeProvider>
    </TypographyProvider>
    </ErrorBoundary>
    </GestureHandlerRootView>
  );
}

function Navigation() {
  const session = useSession();
  const { connectionKey, ready, activeComputerId } = session;
  const current = useRef(session); current.current = session;
  const [pending, setPending] = useState<{ id: string; pane: string; switched: boolean; instance?: string } | null>(null);
  // Above the remounting stack: a notification can select another computer.
  useEffect(() => {
    if (!ready) return;
    return onNotificationTapped((pane, serverId, instance) => {
      const state = current.current;
      const target = serverId ? state.computers.find(c => c.serverId === serverId) :
        state.computers.length === 1 ? state.computers[0] : undefined;
      if (!target) { router.push("/computers"); return; }
      const switched = target.id !== state.activeComputerId;
      setPending({ id: target.id, pane, switched, ...(instance && { instance }) });
      if (switched) void state.switchComputer(target.id).catch(() => {
        setPending(null); router.push("/computers");
      });
    });
  }, [ready]);
  useEffect(() => {
    if (!pending || pending.id !== activeComputerId) return;
    const frame = requestAnimationFrame(() => {
      // The other computer's screens go first: pushed on top of them, its
      // pane was one Back away from a pane of the same id on this computer.
      if (pending.switched) showComputerHome();
      if (pending.instance) openPane(pending.pane, pending.id, pending.instance);
      else openPane(pending.pane, pending.id);
      setPending(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [pending, activeComputerId, connectionKey]);
  return <>
      <Stack
        key={connectionKey}
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
        <Stack.Screen name="computers" options={{ title: "Computers" }} />
        {/* Leaves at once (see the route), so nothing of it should show. */}
        <Stack.Screen name="+not-found" options={{ headerShown: false, animation: "none" }} />
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
            presentation: "card",
            headerShown: false,
            contentStyle: { backgroundColor: theme.surface },
          }}
        />
      </Stack>
      <StatusBar style="light" />
    </>;
}
