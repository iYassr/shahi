import { useState } from "react";
import { StyleSheet } from "react-native";
// react-native's own SafeAreaView is deprecated and warns at runtime; this is
// the supported one, and it already ships with the Expo template.
import { SafeAreaView } from "react-native-safe-area-context";
import { Agents } from "@/screens/agents";
import { Connect } from "@/screens/connect";
import { connection } from "@/lib/api";
import { theme } from "@/lib/theme";

export default function Index() {
  const [connected, setConnected] = useState(Boolean(connection.cookie));
  return (
    <SafeAreaView style={styles.safe}>
      {connected ? <Agents /> : <Connect onConnected={() => setConnected(true)} />}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({ safe: { flex: 1, backgroundColor: theme.void } });
