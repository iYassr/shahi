import { useEffect } from "react";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Pressable, Text } from "react-native";
import { Connect } from "@/screens/connect";
import { useSession } from "@/lib/session";
import { theme } from "@/lib/theme";

export default function ConnectRoute() {
  const { ready, connected, signInSsh, signInRelay, computers, addingComputer } = useSession();

  // Leaving as soon as there is a session, rather than on the button press, so
  // a session restored from storage lands in the same place as a fresh sign-in.
  useEffect(() => {
    if (connected) router.replace("/");
    else if (ready && computers.length > 0 && !addingComputer) router.replace("/computers");
  }, [ready, connected, computers.length, addingComputer]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.void }}>
      {computers.length > 0 && <Pressable accessibilityRole="button" testID="saved-computers"
        onPress={() => router.push("/computers")} style={{ padding: 16 }}>
        <Text style={{ color: theme.peach, fontSize: 16 }}>Choose a saved computer</Text>
      </Pressable>}
      <Connect onConnectedSsh={signInSsh} onConnectedRelay={signInRelay} />
    </SafeAreaView>
  );
}
