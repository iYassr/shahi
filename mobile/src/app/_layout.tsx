import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SessionProvider } from "@/lib/session";
import { theme } from "@/lib/theme";

export default function RootLayout() {
  return (
    // Above the router, so the mirror and the socket survive navigation.
    <SessionProvider>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.void } }} />
      <StatusBar style="light" />
    </SessionProvider>
  );
}
