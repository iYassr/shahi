/**
 * First run: how to reach the server.
 *
 * Two ways in. **Direct** is a tailnet address plus the passcode — the original
 * path, for a box on your tailnet. **SSH** is for everyone else, which for a
 * mass-market app is most people: a server they already reach over SSH, with no
 * tailnet to set up and no sidecar port exposed to the internet. The app opens
 * an SSH session, forwards a local port to the sidecar behind it, and signs in
 * over that — see `lib/tunnel.ts`. Credentials go straight to the Keychain and
 * never leave the phone.
 */
import { useState } from "react";
import { KeyboardAvoidingView, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { api, connection } from "@/lib/api";
import { Logo } from "@/components/icons";
import { openTunnel, closeTunnel, sshTunnelAvailable } from "@/lib/tunnel";
import { committed } from "@/lib/feel";
import {
  emptySshProfile,
  sshProfileReady,
  type SshProfile,
} from "@/lib/ssh";
import { theme } from "@/lib/theme";

/** The one-time server install, the thing the intro exists to hand over. */
const INSTALL_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/iYassr/shahi/master/install.sh | bash";

/**
 * Deliberately blank rather than a guess.
 *
 * A pre-filled address that happens to be wrong looks configured and fails only
 * at connect time — worse than an obviously empty field. The placeholder shows
 * the shape without claiming to know the answer.
 */
const URL_PLACEHOLDER = "http://your-host.your-tailnet.ts.net:7171";

type Mode = "direct" | "ssh";

export function Connect({
  onConnected,
  onConnectedSsh,
}: {
  onConnected: () => void;
  onConnectedSsh: (profile: SshProfile) => void;
}) {
  // First run opens on the setup guide, not a bare form: a new user has nothing
  // to connect to yet, and the old screen assumed a server they had not been
  // told to set up. The guide hands over the one install command and explains
  // where the address and passcode come from; "Connect" moves on to the form.
  const [phase, setPhase] = useState<"intro" | "form">("intro");
  const [mode, setMode] = useState<Mode>("direct");
  const [url, setUrl] = useState("");
  const [passcode, setPasscode] = useState("");
  const [ssh, setSsh] = useState<SshProfile>(emptySshProfile);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (phase === "intro") return <Intro onContinue={() => setPhase("form")} />;

  // Narrow updates so the nested auth object stays a discriminated union.
  const patch = (fields: Partial<SshProfile>) => setSsh((p) => ({ ...p, ...fields }));

  async function connectDirect() {
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

  async function connectSsh() {
    setBusy(true);
    setError(null);
    try {
      connection.baseUrl = await openTunnel(ssh);
      connection.cookie = null;
      await api.login(ssh.passcode);
      onConnectedSsh(ssh);
    } catch (e) {
      // The tunnel may be half-up (opened, then login failed); close it so the
      // next attempt starts from nothing rather than a stale forward.
      await closeTunnel();
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const canConnect = mode === "direct" ? !!passcode && !!url.trim() : sshProfileReady(ssh);

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      // "padding" on Android too, not just iOS. Under edge-to-edge — the
      // default since SDK 54 — the window no longer resizes when the keyboard
      // opens, so leaving Android on the default meant the field stayed put and
      // the keyboard covered it.
      behavior="padding"
    >
      <ScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* The horizontal lockup: cup mark + lowercase mono wordmark. */}
        <View style={styles.brand}>
          <Logo color={theme.peach} size={30} />
          <Text style={styles.title}>shahi</Text>
        </View>

        {/* Two ways in, as a segmented control. */}
        <View style={styles.segment}>
          <Pressable
            style={[styles.segItem, mode === "direct" && styles.segItemOn]}
            onPress={() => setMode("direct")}
            testID="mode-direct"
          >
            <Text style={[styles.segText, mode === "direct" && styles.segTextOn]}>Tailscale</Text>
          </Pressable>
          <Pressable
            style={[styles.segItem, mode === "ssh" && styles.segItemOn]}
            onPress={() => setMode("ssh")}
            testID="mode-ssh"
          >
            <Text style={[styles.segText, mode === "ssh" && styles.segTextOn]}>SSH</Text>
          </Pressable>
        </View>

        {mode === "direct" ? (
          <>
            <Text style={styles.hint}>Reach the agents on your server over Tailscale.</Text>

            <Text style={styles.label}>SERVER</Text>
            <TextInput
              style={styles.input}
              value={url}
              onChangeText={setUrl}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              testID="server-address"
              placeholder={URL_PLACEHOLDER}
              placeholderTextColor={theme.dim}
            />

            <Text style={styles.label}>PASSCODE</Text>
            <TextInput
              style={[styles.input, styles.passcode]}
              value={passcode}
              onChangeText={setPasscode}
              testID="passcode"
              secureTextEntry
              keyboardType="number-pad"
            />
          </>
        ) : (
          <SshForm ssh={ssh} patch={patch} setAuthKind={(kind) => setAuth(setSsh, kind)} />
        )}

        {error && <Text style={styles.error}>{error}</Text>}

        <Pressable
          style={[styles.button, (busy || !canConnect) && styles.buttonOff]}
          disabled={busy || !canConnect}
          onPress={() => void (mode === "direct" ? connectDirect() : connectSsh())}
          testID="connect"
        >
          <Text style={styles.buttonText}>{busy ? "Connecting…" : "Connect"}</Text>
        </Pressable>

        {mode === "ssh" && !sshTunnelAvailable() && (
          <Text style={styles.note}>
            SSH needs the native build of the app. This build can connect over Tailscale.
          </Text>
        )}

        <Pressable onPress={() => setPhase("intro")} hitSlop={12} testID="back-to-setup">
          <Text style={styles.link}>Haven't set up your server yet?</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/**
 * The setup guide, shown before the form on first run.
 *
 * Shahi is bring-your-own-server: it shows the agents on a machine you control,
 * reached through a small helper you install once. A new user has none of that,
 * so this owns the prerequisite instead of dropping them onto a form that asks
 * for an address they do not have — the onboarding cliff. It hands over the one
 * command and says plainly where the address and passcode come from.
 */
function Intro({ onContinue }: { onContinue: () => void }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await Clipboard.setStringAsync(INSTALL_COMMAND);
    committed();
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <ScrollView contentContainerStyle={styles.introBody} showsVerticalScrollIndicator={false}>
      <View style={styles.brand}>
        <Logo color={theme.peach} size={30} />
        <Text style={styles.title}>shahi</Text>
      </View>

      <Text style={styles.lede}>See and answer your terminal agents from your phone.</Text>
      <Text style={styles.introText}>
        Shahi shows the agents running on a server you control — Claude Code, codex, plain shells — and
        lets you reply from anywhere. It talks to a small helper you install on that server once.
      </Text>

      <Text style={styles.step}>1 — On your server, run:</Text>
      <Pressable style={styles.command} onPress={() => void copy()} testID="copy-install">
        <Text style={styles.commandText} numberOfLines={2} selectable>
          {INSTALL_COMMAND}
        </Text>
        <Text style={styles.copy}>{copied ? "Copied" : "Copy"}</Text>
      </Pressable>
      <Text style={styles.introText}>
        It needs a Linux box already running{" "}
        <Text style={styles.linkInline} onPress={() => void Linking.openURL("https://herdr.dev")}>
          herdr
        </Text>
        . When it finishes it prints your server's address and a passcode.
      </Text>

      <Text style={styles.step}>2 — Enter those here.</Text>
      <Text style={styles.introText}>Over Tailscale with the address, or over SSH the way you already log in.</Text>

      <Pressable style={styles.button} onPress={onContinue} testID="intro-continue">
        <Text style={styles.buttonText}>Connect your server</Text>
      </Pressable>
    </ScrollView>
  );
}

/** Swaps the auth branch, keeping the fields of the one being left behind blank. */
function setAuth(setSsh: React.Dispatch<React.SetStateAction<SshProfile>>, kind: "password" | "key") {
  setSsh((p) => ({
    ...p,
    auth: kind === "password" ? { kind, password: "" } : { kind, privateKey: "", passphrase: "" },
  }));
}

function SshForm({
  ssh,
  patch,
  setAuthKind,
}: {
  ssh: SshProfile;
  patch: (fields: Partial<SshProfile>) => void;
  setAuthKind: (kind: "password" | "key") => void;
}) {
  return (
    <>
      <Text style={styles.hint}>Reach your server over SSH — the way you already log into it.</Text>

      <View style={styles.row}>
        <View style={styles.grow}>
          <Text style={styles.label}>HOST</Text>
          <TextInput
            style={styles.input}
            value={ssh.host}
            onChangeText={(host) => patch({ host })}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            testID="ssh-host"
            placeholder="server.example.com"
            placeholderTextColor={theme.dim}
          />
        </View>
        <View style={styles.port}>
          <Text style={styles.label}>PORT</Text>
          <TextInput
            style={styles.input}
            value={String(ssh.port)}
            onChangeText={(t) => patch({ port: Number(t.replace(/[^0-9]/g, "")) || 0 })}
            keyboardType="number-pad"
            testID="ssh-port"
          />
        </View>
      </View>

      <Text style={styles.label}>USERNAME</Text>
      <TextInput
        style={styles.input}
        value={ssh.username}
        onChangeText={(username) => patch({ username })}
        autoCapitalize="none"
        autoCorrect={false}
        testID="ssh-username"
        placeholder="ubuntu"
        placeholderTextColor={theme.dim}
      />

      <Text style={styles.label}>AUTH</Text>
      <View style={styles.segment}>
        <Pressable
          style={[styles.segItem, ssh.auth.kind === "password" && styles.segItemOn]}
          onPress={() => setAuthKind("password")}
          testID="auth-password"
        >
          <Text style={[styles.segText, ssh.auth.kind === "password" && styles.segTextOn]}>Password</Text>
        </Pressable>
        <Pressable
          style={[styles.segItem, ssh.auth.kind === "key" && styles.segItemOn]}
          onPress={() => setAuthKind("key")}
          testID="auth-key"
        >
          <Text style={[styles.segText, ssh.auth.kind === "key" && styles.segTextOn]}>Key</Text>
        </Pressable>
      </View>

      {ssh.auth.kind === "password" ? (
        <TextInput
          style={styles.input}
          value={ssh.auth.password}
          onChangeText={(password) => patch({ auth: { kind: "password", password } })}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          testID="ssh-password"
          placeholder="password"
          placeholderTextColor={theme.dim}
        />
      ) : (
        <>
          <TextInput
            style={[styles.input, styles.key]}
            value={ssh.auth.privateKey}
            onChangeText={(privateKey) =>
              patch({ auth: { kind: "key", privateKey, passphrase: ssh.auth.kind === "key" ? ssh.auth.passphrase : "" } })
            }
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            testID="ssh-key"
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
            placeholderTextColor={theme.dim}
          />
          <Text style={styles.label}>PASSPHRASE (IF ANY)</Text>
          <TextInput
            style={styles.input}
            value={ssh.auth.passphrase}
            onChangeText={(passphrase) =>
              patch({ auth: { kind: "key", privateKey: ssh.auth.kind === "key" ? ssh.auth.privateKey : "", passphrase } })
            }
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            testID="ssh-passphrase"
          />
        </>
      )}

      {/* No sidecar-port field: the sidecar is always on the installer's
          default (7171), and a mass-market user should not have to know a port
          exists. `remotePort` stays at DEFAULT_SIDECAR_PORT from the profile. */}
      <Text style={styles.label}>PASSCODE</Text>
      <TextInput
        style={[styles.input, styles.passcode]}
        value={ssh.passcode}
        onChangeText={(passcode) => patch({ passcode })}
        secureTextEntry
        keyboardType="number-pad"
        testID="ssh-passcode"
      />
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.void },
  body: { flexGrow: 1, justifyContent: "center", padding: 28, gap: 10 },
  brand: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 6 },
  title: { color: theme.fg, fontFamily: theme.mono, fontSize: 26, fontWeight: "500", letterSpacing: -0.5 },
  hint: { color: theme.dim, fontSize: 14, marginBottom: 12 },

  // Intro / setup guide
  introBody: { flexGrow: 1, justifyContent: "center", padding: 28, gap: 14 },
  lede: { color: theme.fg, fontSize: 20, fontWeight: "600", lineHeight: 27, marginTop: 4 },
  introText: { color: theme.dim, fontSize: 15, lineHeight: 22 },
  step: { color: theme.peach, fontFamily: theme.mono, fontSize: 13, letterSpacing: 0.5, marginTop: 10 },
  command: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.lineBright,
    borderRadius: 10,
    borderCurve: "continuous",
    padding: 14,
  },
  commandText: { flex: 1, color: theme.fg, fontFamily: theme.mono, fontSize: 12.5, lineHeight: 18 },
  copy: { color: theme.peach, fontFamily: theme.mono, fontSize: 13, fontWeight: "600" },
  linkInline: { color: theme.peach },
  link: { color: theme.dim, fontSize: 14, textAlign: "center", marginTop: 18, textDecorationLine: "underline" },
  label: { color: theme.dim, fontFamily: theme.mono, fontSize: 11, letterSpacing: 1.2, marginTop: 8 },
  input: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.lineBright,
    borderRadius: 8, borderCurve: "continuous",
    color: theme.fg,
    fontFamily: theme.mono,
    fontSize: 16,
    padding: 13,
  },
  passcode: { letterSpacing: 6, textAlign: "center", fontSize: 20 },
  key: { minHeight: 96, textAlignVertical: "top", fontSize: 12 },
  row: { flexDirection: "row", gap: 10 },
  grow: { flex: 1 },
  port: { width: 92 },
  segment: {
    flexDirection: "row",
    gap: 4,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.lineBright,
    borderRadius: 10, borderCurve: "continuous",
    padding: 4,
    marginTop: 8,
  },
  segItem: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: 7, borderCurve: "continuous" },
  segItemOn: { backgroundColor: theme.raised },
  segText: { color: theme.dim, fontFamily: theme.mono, fontSize: 13 },
  segTextOn: { color: theme.peach, fontWeight: "600" },
  error: { color: theme.rose, fontSize: 13, marginTop: 4 },
  note: { color: theme.dim, fontSize: 12, marginTop: 12, lineHeight: 18 },
  button: {
    backgroundColor: theme.peach,
    borderRadius: 8, borderCurve: "continuous",
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 16,
  },
  buttonOff: { opacity: 0.35 },
  buttonText: { color: theme.void, fontWeight: "600", fontSize: 16 },
});
