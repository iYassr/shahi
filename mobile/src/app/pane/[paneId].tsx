import { useEffect } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Pane } from "@/screens/pane";
import { useSession } from "@/lib/session";
import { theme } from "@/lib/theme";

export default function PaneRoute() {
  // Route params arrive as string | string[]; a pane id is always the former.
  const { paneId, view } = useLocalSearchParams<{ paneId: string; view?: string }>();
  const { session } = useSession();

  // A pane can vanish under us — closed from the TUI while this was open.
  // Popping beats sitting on a dead conversation forever; the space route
  // already behaves this way.
  const gone = session != null && !session.panes.some((p) => p.paneId === String(paneId));
  useEffect(() => {
    if (gone && router.canGoBack()) router.back();
  }, [gone]);
  return (
    // Bottom only: the native header owns the top inset now.
    <SafeAreaView edges={["bottom"]} style={{ flex: 1, backgroundColor: theme.void }}>
      <Pane paneId={String(paneId)} initialView={view === "screen" ? "screen" : "reader"} />
    </SafeAreaView>
  );
}
