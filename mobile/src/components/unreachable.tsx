/**
 * The screen for a server that could not be read, when there is nothing older
 * to show instead.
 *
 * It says which server, in the words of `lib/api`'s `describeTransportFailure`
 * why, and offers the two things a person can actually do: try again, or go
 * and change the address. It exists because what used to fill this space was
 * the platform's own error string, and "at ExpoModulesCore/Promise.swift:56"
 * is not something to show anyone.
 */
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "@/lib/theme";

export function Unreachable({
  title,
  message,
  server,
  onRetry,
  onSwitch,
}: {
  title: string;
  message: string;
  /** The configured address, shown so a typo is visible from here. */
  server: string;
  /** Settles when the attempt has been applied, success or not — the button stays busy until then. */
  onRetry: () => Promise<void>;
  onSwitch: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function retry() {
    setBusy(true);
    try {
      await onRetry();
    } catch {
      // The outcome arrives through `message`, from the provider that owns the
      // error. A rejection here would only become an unhandled promise.
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.screen} testID="unreachable">
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.server} numberOfLines={1}>
        {server.replace(/^https?:\/\//, "")}
      </Text>
      <Text style={styles.message}>{message}</Text>
      <Pressable
        accessibilityRole="button"
        style={[styles.button, busy && styles.buttonOff]}
        disabled={busy}
        onPress={() => void retry()}
        testID="retry"
      >
        <Text style={styles.buttonText}>{busy ? "Trying…" : "Try again"}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={onSwitch} hitSlop={12} testID="switch-server">
        <Text style={styles.link}>Switch server</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.void, justifyContent: "center", padding: 32, gap: 12 },
  title: { color: theme.fg, fontSize: 22, fontWeight: "600", letterSpacing: -0.3 },
  server: { color: theme.dim, fontFamily: theme.mono, fontSize: 13 },
  message: { color: theme.dim, fontSize: 16, lineHeight: 23 },
  button: {
    backgroundColor: theme.peach,
    borderRadius: 8,
    borderCurve: "continuous",
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 12,
  },
  buttonOff: { opacity: 0.35 },
  buttonText: { color: theme.void, fontWeight: "600", fontSize: 16 },
  link: { color: theme.dim, fontSize: 14, textAlign: "center", marginTop: 6, textDecorationLine: "underline" },
});
