import { useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Pane } from "@/screens/pane";
import { theme } from "@/lib/theme";

export default function PaneRoute() {
  // Route params arrive as string | string[]; a pane id is always the former.
  const { paneId } = useLocalSearchParams<{ paneId: string }>();
  return (
    // Bottom only: the native header owns the top inset now.
    <SafeAreaView edges={["bottom"]} style={{ flex: 1, backgroundColor: theme.void }}>
      <Pane paneId={String(paneId)} />
    </SafeAreaView>
  );
}
