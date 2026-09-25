import { useEffect } from "react";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Pressable} from "react-native";
import { Text } from "@/components/text";
import { Connect } from "@/screens/connect";
import { useSession } from "@/lib/session";
import { showComputerHome } from "@/lib/navigate";
import { usePendingPairing } from "@/lib/incoming-pairing";
import { theme } from "@/lib/theme";

export default function ConnectRoute() {
  const { ready, connected, signInSsh, signInRelay, computers, addingComputer } = useSession();
  const pairing = usePendingPairing();

  // Leaving as soon as there is a session, rather than on the button press, so
  // a session restored from storage lands in the same place as a fresh sign-in.
  // A pairing link waits here for its answer whatever is saved or open: these
  // redirects used to carry it away unseen whenever a computer was saved.
  useEffect(() => {
    if (pairing) return;
    // A pairing link can arrive over another computer's open pane, and a
    // replace of the top alone left that pane underneath (pre-release bug hunt).
    if (connected) showComputerHome();
    else if (ready && computers.length > 0 && !addingComputer) router.replace("/computers");
  }, [pairing, ready, connected, computers.length, addingComputer]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.void }}>
      {computers.length > 0 && !pairing && <Pressable accessibilityRole="button" testID="saved-computers"
        onPress={() => router.push("/computers")} style={{ padding: 16 }}>
        <Text style={{ color: theme.peach, fontSize: 16 }}>Choose a saved computer</Text>
      </Pressable>}
      <Connect onConnectedSsh={signInSsh} onConnectedRelay={signInRelay} />
    </SafeAreaView>
  );
}
