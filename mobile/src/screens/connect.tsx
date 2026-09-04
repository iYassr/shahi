/**
 * First run: how to reach the server.
 *
 * Two ways in. **Scanning a code** is the intended one: the server prints a
 * QR (`herdr plugin action invoke shahi.pair`), the phone reads the relay and a
 * one-time secret off it, checks it is talking to the server that printed it,
 * and comes away with a session bound to this device — which Settings can
 * later revoke. That works from anywhere (`docs/relay.md`). **SSH** is for a
 * server you already reach over SSH, with no relay in the path and no sidecar
 * port exposed: the app opens an SSH session, forwards a local port to the
 * sidecar behind it, and signs in over that — see `lib/tunnel.ts`.
 * Credentials go straight to the Keychain and never leave the phone.
 */
import { useState, useEffect } from "react";
import { KeyboardAvoidingView, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Device from "expo-device";
import type { PairingPayload } from "@shahi/shared";
import { api, connection, UnauthorizedError } from "@/lib/api";
import { closeRelay, pairingTarget, type RelayIdentity } from "@/lib/relay";
import { Logo } from "@/components/icons";
import { Scanner } from "@/components/scanner";
import { parsePairingUrl } from "@/lib/pairing";
import { useURL } from "expo-linking";
import { openTunnel, closeTunnel, sshTunnelAvailable } from "@/lib/tunnel";
import { committed } from "@/lib/feel";
import {
  emptySshProfile,
  sshProfileReady,
  type SshProfile,
} from "@/lib/ssh";
import { theme } from "@/lib/theme";

/** The one-time server install, the thing the intro exists to hand over. */
export const INSTALL_COMMAND =
  "herdr plugin install iYassr/shahi\nherdr plugin action invoke shahi.pair";

export function Connect({
  onConnectedSsh,
  onConnectedRelay,
}: {
  onConnectedSsh: (profile: SshProfile) => void;
  onConnectedRelay: (identity: RelayIdentity) => void;
}) {
  // First run opens on the setup guide, not a bare form: a new user has nothing
  // to connect to yet, and the old screen assumed a server they had not been
  // told to set up. The guide hands over the one install command and explains
  // where the address and passcode come from; "Connect" moves on to the form.
  const [phase, setPhase] = useState<"intro" | "form">("intro");
  const [ssh, setSsh] = useState<SshProfile>(emptySshProfile);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  // A code that arrived as a link (useURL), not from the camera. It is shown
  // for confirmation before anything is sent: a tapped or injected
  // shahi://pair link must not silently repoint the app at a stranger's box
  // (pentest M2). The camera scanner is already an explicit act and pairs
  // directly.
  const [pending, setPending] = useState<PairingPayload | null>(null);

  // A pairing code can arrive as a link as well as a picture: `shahi://pair#…`
  // tapped in a terminal or a message, or opened by a test — the simulator has
  // no camera to point at anything. It is the same payload the scanner reads,
  // so it takes the same path; an unparseable link is ignored rather than
  // reported, since nothing on screen asked for it.
  const openedUrl = useURL();
  useEffect(() => {
    const payload = openedUrl ? parsePairingUrl(openedUrl) : null;
    // Show it, do not act on it: the confirm card is the tap the finding wants
    // between an untrusted link and this phone's secret.
    if (payload) setPending(payload);
  }, [openedUrl]);

  // A link is asking to pair. Confirm the target before a byte is sent.
  if (pending) {
    const host = pending.relay.replace(/^https?:\/\//, "");
    return (
      <View style={styles.introBody}>
        <Text style={styles.lede}>Pair this phone?</Text>
        <Text style={styles.introText}>
          A link is asking to connect this phone to a Shahi server. Only continue if you opened this
          code yourself, from a server you control.
        </Text>
        <Text style={styles.label}>SERVER</Text>
        <Text style={styles.mono}>{host}</Text>
        <Text style={styles.label}>IDENTITY</Text>
        <Text style={styles.mono}>{pending.server.slice(0, 16)}…</Text>
        {error && <Text style={styles.error}>{error}</Text>}
        <Pressable
          style={[styles.button, busy && styles.buttonOff]}
          disabled={busy}
          testID="confirm-pair"
          onPress={() => {
            const payload = pending;
            setPending(null);
            void pair(payload);
          }}
        >
          <Text style={styles.buttonText}>{busy ? "Pairing…" : `Pair with ${host}`}</Text>
        </Pressable>
        <Pressable style={styles.link} onPress={() => { setPending(null); setError(null); }} testID="confirm-cancel">
          <Text style={styles.link}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  if (phase === "intro") return <Intro onContinue={() => setPhase("form")} />;

  /**
   * A scanned code. The endpoint on it is trusted only as far as `/api/meta`
   * agreeing about who it is: a code aimed at the wrong address — or a
   * stranger's server at the right one — is refused before the secret is
   * ever sent there. Through a relay the same check runs on a link keyed
   * from the code's secret; the claim then answers with the device this phone
   * becomes, and the session reconnects as that device.
   */
  async function pair(payload: PairingPayload) {
    setBusy(true);
    setError(null);
    const where = payload.relay;
    try {
      connection.cookie = null;
      connection.baseUrl = "";
      connection.relay = pairingTarget(payload.relay, payload.server, payload.secret);
      const info = await api.meta();
      if (info.serverId !== payload.server) {
        throw new Error(`${where} is a Shahi server, but not the one that printed this code.`);
      }
      // The name is what Settings lists, on every phone; expo-device knows it
      // on a device and answers null on a simulator.
      // `deviceName` is the model class ("iPhone") on iOS 16+ without an
      // entitlement Apple grants case by case, so two phones would be
      // indistinguishable in Settings; the model name is always populated.
      const label =
        Device.deviceName && Device.deviceName !== "iPhone" ? Device.deviceName : (Device.modelName ?? "iPhone");
      const claim = await api.claimRelayPairing(payload.secret, label);
      onConnectedRelay({
        relay: payload.relay,
        serverId: payload.server,
        deviceId: claim.deviceId,
        deviceSecret: claim.deviceSecret,
      });
    } catch (e) {
      // A box that refuses the link does not know this code — spent, expired,
      // or minted before a restart. The transport's words are about a device
      // that is no longer paired; here there was never a device, so say what
      // is true instead. The half-open pairing link is closed either way.
      connection.relay = null;
      closeRelay();
      setError(
        e instanceof UnauthorizedError
          ? "That pairing code is not valid. A code works once and for ten minutes — print a new one."
          : (e as Error).message,
      );
      setBusy(false);
    }
  }

  if (scanning) {
    return (
      <Scanner
        onCancel={() => setScanning(false)}
        onScanned={(data) => {
          const payload = parsePairingUrl(data);
          if (!payload) return false;
          setScanning(false);
          void pair(payload);
          return true;
        }}
      />
    );
  }

  // Narrow updates so the nested auth object stays a discriminated union.
  const patch = (fields: Partial<SshProfile>) => setSsh((p) => ({ ...p, ...fields }));

  async function connectSsh() {
    setBusy(true);
    setError(null);
    try {
      connection.relay = null;
      connection.baseUrl = await openTunnel(ssh);
      connection.cookie = null;
      await api.meta();
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

  const canConnect = sshProfileReady(ssh);

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
        {/* The horizontal lockup: cup mark + lowercase mono wordmark — and the
            intended way in beside it. It sits in the title row on purpose: as
            a card above the form it pushed the Connect button under the
            keyboard on an iPhone 17, which every flow, and every person typing
            by hand, then had to scroll for. The intro already says where the
            code comes from. */}
        <View style={styles.brand}>
          <View style={styles.lockup}>
            <Logo color={theme.peach} size={30} />
            <Text style={styles.title}>shahi</Text>
          </View>
          <Pressable
            style={styles.scan}
            onPress={() => setScanning(true)}
            disabled={busy}
            testID="scan-code"
            accessibilityHint="On the server: herdr plugin action invoke shahi.pair"
          >
            <Text style={styles.scanText}>Scan a code</Text>
          </Pressable>
        </View>

        <Text style={styles.hint}>Or reach the sidecar through a server you already SSH into.</Text>

        <SshForm ssh={ssh} patch={patch} setAuthKind={(kind) => setAuth(setSsh, kind)} />

        {error && <Text style={styles.error}>{error}</Text>}

        <Pressable
          style={[styles.button, (busy || !canConnect) && styles.buttonOff]}
          disabled={busy || !canConnect}
          onPress={() => void connectSsh()}
          testID="connect"
        >
          <Text style={styles.buttonText}>{busy ? "Connecting…" : "Connect"}</Text>
        </Pressable>

        {!sshTunnelAvailable() && (
          <Text style={styles.note}>
            SSH needs the native build of the app. Scan a pairing code instead.
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
        It needs a Mac or Linux machine already running{" "}
        <Text style={styles.linkInline} onPress={() => void Linking.openURL("https://herdr.dev")}>
          herdr
        </Text>
        . The second command opens a one-time pairing code inside herdr.
      </Text>

      <Text style={styles.step}>2 — Pair this phone.</Text>
      <Text style={styles.introText}>
        Scan the code in herdr — or enter the address and passcode over Tailscale or SSH, the way you already log in.
      </Text>

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
  brand: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 },
  lockup: { flexDirection: "row", alignItems: "center", gap: 12 },
  title: { color: theme.fg, fontFamily: theme.mono, fontSize: 26, fontWeight: "500", letterSpacing: -0.5 },
  hint: { color: theme.dim, fontSize: 14, marginBottom: 12 },
  scan: {
    borderWidth: 1,
    borderColor: theme.peach,
    borderRadius: 999,
    minHeight: 36,
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  scanText: { color: theme.peach, fontSize: 14, fontWeight: "600" },
  mono: { fontFamily: theme.mono, color: theme.fg },

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
