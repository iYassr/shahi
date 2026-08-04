import { SafeAreaView } from "react-native-safe-area-context";
import { Spaces } from "@/screens/spaces";
import { useSession } from "@/lib/session";
import { theme } from "@/lib/theme";
import { openPane } from "@/lib/navigate";

export default function SpacesTab() {
  const { session, refresh } = useSession();
  return (
    // Top edge only, same as the Agents tab: the screen draws its own topbar
    // and the native tab bar owns the bottom.
    <SafeAreaView edges={["top"]} style={{ flex: 1, backgroundColor: theme.void }}>
      <Spaces session={session} onOpenPane={openPane} onChanged={refresh} />
    </SafeAreaView>
  );
}
