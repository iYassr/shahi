import { Pressable, ScrollView, StyleSheet } from "react-native";
import { Text } from "@/components/text";
import type { HostKeyReview } from "@/lib/tunnel";
import { theme } from "@/lib/theme";

/** Where each key type's public half lives on a stock OpenSSH server. */
const HOST_KEY_FILES: Record<string, string> = {
  ED25519: "/etc/ssh/ssh_host_ed25519_key.pub",
  ECDSA: "/etc/ssh/ssh_host_ecdsa_key.pub",
  RSA: "/etc/ssh/ssh_host_rsa_key.pub",
};

/**
 * An SSH server's identity, shown before this phone sends it a login.
 *
 * The first key used to be trusted without a word, with the password in the
 * same native call, although the docs told people to verify it: there was
 * nothing to verify against (pre-release review). A changed key used to be a
 * dead end; now it shows both fingerprints and can be trusted deliberately,
 * which is how a reinstalled server comes back. A key an earlier version
 * trusted unseen is shown once, the first time this version relies on it,
 * from Connect or from a saved computer reconnecting. The command is the one
 * that prints the same `SHA256:` form on the server itself.
 */
export function HostKeyCard({ review, answer }: { review: HostKeyReview; answer: (trusted: boolean) => void }) {
  const changed = review.previous !== null;
  const file = HOST_KEY_FILES[review.keyType];
  const command = file ? `ssh-keygen -lf ${file}` : "ssh-keyscan localhost | ssh-keygen -lf -";
  const where = `${review.host}${review.port === 22 ? "" : `:${review.port}`}`;
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.body} testID="host-key-review">
      <Text style={styles.lede} accessibilityRole="header">
        {changed ? "This computer’s identity has changed" : "Check this computer’s identity"}
      </Text>
      <Text style={styles.text}>
        {changed
          ? `${where} presented a different key from the one this phone trusted before. That happens when the computer is reinstalled or replaced, and also when someone is intercepting the connection. Only continue if the new fingerprint matches the one on the computer.`
          : review.trustedUnseen
            ? `An earlier version of Shahi trusted this key for ${where} without showing it to you. Before your login is sent again, check that this fingerprint matches the one on the computer.`
            : `This phone has not connected to ${where} before. Before your login is sent, check that this fingerprint matches the one on the computer.`}
      </Text>
      {changed && <>
        <Text style={styles.label}>PREVIOUSLY TRUSTED</Text>
        <Text style={styles.fingerprint} selectable testID="host-key-previous">{review.previous}</Text>
      </>}
      <Text style={styles.label}>{changed ? `NOW PRESENTED (${review.keyType})` : `${review.keyType} KEY FINGERPRINT`}</Text>
      <Text style={styles.fingerprint} selectable testID="host-key-fingerprint">{review.fingerprint}</Text>
      <Text style={styles.text}>On the computer, run:</Text>
      <Text style={styles.fingerprint} selectable>{command}</Text>
      <Pressable accessibilityRole="button" style={[styles.button, changed && styles.buttonWarn]} onPress={() => answer(true)} testID="trust-host-key">
        <Text style={styles.buttonText}>{changed ? "Trust the new key" : "Trust and connect"}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={() => answer(false)} hitSlop={12} testID="reject-host-key">
        <Text style={styles.link}>Cancel</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.void },
  body: { flexGrow: 1, justifyContent: "center", padding: 28, gap: 14 },
  lede: { color: theme.fg, fontSize: 20, fontWeight: "600", lineHeight: 27, marginTop: 4 },
  text: { color: theme.dim, fontSize: 15, lineHeight: 22 },
  label: { color: theme.dim, fontSize: 11, marginTop: 8 },
  fingerprint: { fontFamily: theme.mono, color: theme.fg, fontSize: 13, lineHeight: 19 },
  button: {
    backgroundColor: theme.peach,
    borderRadius: 8, borderCurve: "continuous",
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 16,
  },
  buttonWarn: { backgroundColor: theme.rose },
  buttonText: { color: theme.void, fontWeight: "600", fontSize: 16 },
  link: { color: theme.dim, fontSize: 14, textAlign: "center", marginTop: 18, textDecorationLine: "underline" },
});
