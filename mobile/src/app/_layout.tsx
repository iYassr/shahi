import { useEffect, useRef, useState } from "react";
import { router } from "expo-router";
import { onNotificationTapped } from "@/lib/push";
import { openPane } from "@/lib/navigate";
import { Stack } from "expo-router/stack";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SessionProvider, useSession } from "@/lib/session";
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
      <Navigation />
    </SessionProvider>
    </ErrorBoundary>
    </GestureHandlerRootView>
  );
}

function Navigation() {
  const session = useSession();
  const { connectionKey, ready, activeComputerId } = session;
  const current = useRef(session); current.current = session;
  const [pending, setPending] = useState<{ id: string; pane: string } | null>(null);
  // Above the remounting stack: a notification can select another computer.
  useEffect(() => {
    if (!ready) return;
    return onNotificationTapped((pane, serverId) => {
      const state = current.current;
      const target = serverId ? state.computers.find(c => c.serverId === serverId) :
        state.computers.length === 1 ? state.computers[0] : undefined;
      if (!target) { router.push("/computers"); return; }
      setPending({ id: target.id, pane });
      if (target.id !== state.activeComputerId) void state.switchComputer(target.id).catch(() => {
        setPending(null); router.push("/computers");
      });
    });
  }, [ready]);
  useEffect(() => {
    if (!pending || pending.id !== activeComputerId) return;
    const frame = requestAnimationFrame(() => { openPane(pending.pane); setPending(null); });
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
    </>;
}
