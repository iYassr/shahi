import { useState } from "react";
import { SafeAreaView, StyleSheet } from "react-native";
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
