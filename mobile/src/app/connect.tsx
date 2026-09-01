import { useEffect } from "react";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Connect } from "@/screens/connect";
import { useSession } from "@/lib/session";
import { theme } from "@/lib/theme";

export default function ConnectRoute() {
  const { connected, signIn, signInSsh, signInRelay } = useSession();

  // Leaving as soon as there is a session, rather than on the button press, so
  // a session restored from storage lands in the same place as a fresh sign-in.
  useEffect(() => {
    if (connected) router.replace("/");
  }, [connected]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.void }}>
      <Connect onConnected={signIn} onConnectedSsh={signInSsh} onConnectedRelay={signInRelay} />
    </SafeAreaView>
  );
}
