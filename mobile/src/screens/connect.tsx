/**
 * First run: where the server is, and the passcode.
 *
 * The web client needs neither — it is served by the thing it talks to. A
 * native app has no origin to infer from, so the tailnet address has to be
 * asked for once and kept.
 */
import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { api, connection } from "@/lib/api";
import { theme } from "@/lib/theme";

/**
 * Deliberately blank rather than a guess.
 *
 * A pre-filled address that happens to be wrong looks configured and fails only
 * at connect time — worse than an obviously empty field. The placeholder shows
 * the shape without claiming to know the answer.
 */
const URL_PLACEHOLDER = "http://your-host.your-tailnet.ts.net:7171";

export function Connect({ onConnected }: { onConnected: () => void }) {
  const [url, setUrl] = useState("");
  const [passcode, setPasscode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      connection.baseUrl = url.trim().replace(/\/$/, "");
      await api.login(passcode);
      onConnected();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <Text style={styles.title}>herdr</Text>
      <Text style={styles.hint}>Reach the agents on your server over Tailscale.</Text>

      <Text style={styles.label}>SERVER</Text>
      <TextInput
        style={styles.input}
        value={url}
        onChangeText={setUrl}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder={URL_PLACEHOLDER}
        placeholderTextColor={theme.dim}
      />

      <Text style={styles.label}>PASSCODE</Text>
      <TextInput
        style={[styles.input, styles.passcode]}
        value={passcode}
        onChangeText={setPasscode}
        secureTextEntry
        keyboardType="number-pad"
      />

      {error && <Text style={styles.error}>{error}</Text>}

      <Pressable
        style={[styles.button, (busy || !passcode || !url.trim()) && styles.buttonOff]}
        disabled={busy || !passcode || !url.trim()}
        onPress={() => void connect()}
      >
        <Text style={styles.buttonText}>{busy ? "Connecting…" : "Connect"}</Text>
      </Pressable>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.void, justifyContent: "center", padding: 28, gap: 10 },
  title: { color: theme.fg, fontFamily: theme.mono, fontSize: 24, fontWeight: "600" },
  hint: { color: theme.dim, fontSize: 14, marginBottom: 12 },
  label: { color: theme.dim, fontFamily: theme.mono, fontSize: 11, letterSpacing: 1.2, marginTop: 8 },
  input: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.lineBright,
    borderRadius: 8,
    color: theme.fg,
    fontFamily: theme.mono,
    fontSize: 16,
    padding: 13,
  },
  passcode: { letterSpacing: 6, textAlign: "center", fontSize: 20 },
  error: { color: theme.rose, fontSize: 13 },
  button: {
    backgroundColor: theme.peach,
    borderRadius: 8,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 16,
  },
  buttonOff: { opacity: 0.35 },
  buttonText: { color: theme.void, fontWeight: "600", fontSize: 16 },
});
