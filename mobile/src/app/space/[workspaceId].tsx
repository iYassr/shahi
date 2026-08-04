import { router, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { SpaceDetail } from "@/screens/spaces";
import { useSession } from "@/lib/session";
import { theme } from "@/lib/theme";

export default function SpaceRoute() {
  const { workspaceId } = useLocalSearchParams<{ workspaceId: string }>();
  const { session } = useSession();
  const space = session?.workspaces.find((w) => w.workspaceId === String(workspaceId));

  // A space can vanish under us — closed from the TUI while this was open.
  // Popping beats rendering a screen about nothing.
  useEffect(() => {
    if (session && !space) router.back();
  }, [session, space]);

  if (!session || !space) return null;
  return (
    <SafeAreaView edges={["bottom"]} style={{ flex: 1, backgroundColor: theme.void }}>
      <SpaceDetail space={space} session={session} />
    </SafeAreaView>
  );
}
