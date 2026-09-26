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
import { useState, useEffect, useRef } from "react";
import { InputAccessoryView, Keyboard, Platform, KeyboardAvoidingView, Linking, Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Text } from "@/components/text";
import * as Clipboard from "expo-clipboard";
import * as Device from "expo-device";
import type { PairingPayload } from "@shahi/shared";
import { createApi, UnauthorizedError, type Connection } from "@/lib/api";
import { closeRelay, pairingTarget, type RelayIdentity, type RelayTarget } from "@/lib/relay";
import { Wordmark } from "@/components/icons";
import { GreetingLogo } from "@/components/greeting-logo";
import { Scanner } from "@/components/scanner";
import { HostKeyCard } from "@/components/host-key-card";
import { PrivacyLinks } from "@/components/privacy-links";
import { parsePairingUrl } from "@/lib/pairing";
import { dismissPairing, usePendingPairing } from "@/lib/incoming-pairing";
import { openTunnel, closeTunnel, sshTunnelAvailable, type HostKeyReview } from "@/lib/tunnel";
import { committed } from "@/lib/feel";
import {
  emptySshProfile,
  sshHost,
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
  /** With the connection Connect signed in on, for the saved computer to adopt. */
  onConnectedSsh: (profile: SshProfile, connection: Connection) => void;
  onConnectedRelay: (identity: RelayIdentity) => void;
}) {
  // Relay pairing is the default; SSH fields appear only when requested.
  const [phase, setPhase] = useState<"intro" | "form">("intro");
  const [ssh, setSsh] = useState<SshProfile>(emptySshProfile);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A link's failure belongs to that link's code. One error for the whole
  // screen showed a spent code's "not valid" on the next link's card, for a
  // different computer, before anything had been tried (pre-release bug hunt).
  const [linkFailure, setLinkFailure] = useState<{ payload: PairingPayload; message: string } | null>(null);
  const [scanning, setScanning] = useState(false);
  // A code that arrived as a link, not from the camera: `shahi://pair#…`
  // tapped in a terminal or a message, opened by the iPhone Camera, or by a
  // test (the simulator has no camera). `lib/incoming-pairing` holds it from
  // the moment it arrives. It is shown for confirmation before anything is
  // sent: a tapped or injected link must not silently repoint the app at a
  // stranger's box (pentest M2). The camera scanner is already an explicit
  // act and pairs directly.
  const pending = usePendingPairing();
  // An SSH server's host key waiting for the person's decision.
  const [hostKey, setHostKey] = useState<{ review: HostKeyReview; answer: (trusted: boolean) => void } | null>(null);
  const answerRef = useRef<((trusted: boolean) => void) | null>(null);
  // Leaving the screen is a refusal: the login waiting on it must never run.
  useEffect(() => () => answerRef.current?.(false), []);
  const reviewHostKey = (review: HostKeyReview) => new Promise<boolean>((resolve) => {
    const answer = (trusted: boolean) => { answerRef.current = null; setHostKey(null); resolve(trusted); };
    answerRef.current = answer;
    setHostKey({ review, answer });
  });

  // A link is asking to pair. Confirm the target before a byte is sent. It
  // scrolls: at the largest text sizes the warning alone is taller than the
  // screen, and in a plain View it pushed Pair and Cancel off the bottom, out
  // of reach (seen on the simulator at AX5, pre-release verification).
  if (pending) {
    const host = pending.relay.replace(/^https?:\/\//, "");
    const failed = linkFailure?.payload === pending ? linkFailure.message : null;
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.introBody} testID="pair-review">
        <Text style={styles.lede} accessibilityRole="header">Pair this phone?</Text>
        <Text style={styles.introText}>
          A link is asking to connect this phone to a Shahi computer. Only continue if you opened this
          link yourself, from a computer you control.
        </Text>
        <Text style={styles.label}>RELAY</Text>
        <Text style={styles.mono}>{host}</Text>
        <Text style={styles.label}>COMPUTER</Text>
        <Text style={styles.mono}>{pending.server.slice(0, 16)}…</Text>
        {failed && <Text style={styles.error}>{failed}</Text>}
        <Pressable
          accessibilityRole="button"
          style={[styles.button, busy && styles.buttonOff]}
          disabled={busy}
          testID="confirm-pair"
          onPress={() => {
            void pair(pending, true);
          }}
        >
          <Text style={styles.buttonText}>{busy ? "Pairing…" : "Pair with this computer"}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" style={styles.link} onPress={() => { dismissPairing(pending); setLinkFailure(null); }} testID="confirm-cancel">
          <Text style={styles.link}>Cancel</Text>
        </Pressable>
      </ScrollView>
    );
  }


  /**
   * A scanned code. The endpoint on it is trusted only as far as `/api/meta`
   * agreeing about who it is: a code aimed at the wrong address — or a
   * stranger's server at the right one — is refused before the secret is
   * ever sent there. Through a relay the same check runs on a link keyed
   * from the code's secret; the claim then answers with the device this phone
   * becomes, and the session reconnects as that device.
   */
  async function pair(payload: PairingPayload, fromLink: boolean) {
    setBusy(true);
    setError(null);
    setLinkFailure(null);
    const where = payload.relay;
    // A connection of its own. This used to borrow the shared one, which the
    // session overwrites with the open computer's on every pushed message: one
    // landing while `meta` was in flight sent the claim, with this code's
    // one-time secret, to the open computer, and the failure then closed that
    // computer's link and left it offline (pre-release bug hunt).
    let target: RelayTarget | undefined;
    try {
      target = pairingTarget(payload.relay, payload.server, payload.secret);
      const pairing = createApi({ baseUrl: "", cookie: null, relay: target });
      const info = await pairing.meta();
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
      const claim = await pairing.claimRelayPairing(payload.secret, label);
      onConnectedRelay({
        relay: payload.relay,
        serverId: payload.server,
        deviceId: claim.deviceId,
        deviceSecret: claim.deviceSecret,
      });
      // After signing in, so the route never sees "no link, not connected"
      // in between and sends a person with saved computers to the chooser.
      // Only this code's link: another may have arrived while it paired.
      dismissPairing(payload);
    } catch (e) {
      // A box that refuses the link does not know this code — spent, expired,
      // or minted before a restart. The transport's words are about a device
      // that is no longer paired; here there was never a device, so say what
      // is true instead.
      const message = e instanceof UnauthorizedError
        ? "That pairing code is not valid. A code works once and for ten minutes — show a new one on your computer."
        : (e as Error).message;
      if (fromLink) setLinkFailure({ payload, message });
      else setError(message);
    } finally {
      // The pairing link either way: a paired phone reconnects as its device.
      if (target) closeRelay(target);
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
          void pair(payload, false);
          return true;
        }}
      />
    );
  }

  if (phase === "intro") return <Intro
    onScan={() => { setError(null); setScanning(true); }}
    onSsh={() => { setError(null); setPhase("form"); }}
    busy={busy}
    error={error}
  />;

  // Narrow updates so the nested auth object stays a discriminated union.
  const patch = (fields: Partial<SshProfile>) => setSsh((p) => ({ ...p, ...fields }));

  async function connectSsh() {
    setBusy(true);
    setError(null);
    let tunnel = "";
    try {
      // Its own connection, for the reason `pair` has one. Failures on it
      // name the SSH host rather than this phone's end of the tunnel.
      const signingIn: Connection = { baseUrl: "", cookie: null, relay: null, via: sshHost(ssh) };
      const client = createApi(signingIn);
      // A key this phone has not trusted for that server is shown first; the
      // login is sent only if the person trusts it.
      tunnel = await openTunnel(ssh, reviewHostKey);
      signingIn.baseUrl = tunnel;
      await client.meta();
      await client.login(ssh.passcode);
      onConnectedSsh(ssh, signingIn);
    } catch (e) {
      // The tunnel may be half-up (opened, then login failed); close it so the
      // next attempt starts from nothing rather than a stale forward. Only
      // this attempt's own: a saved computer's forward to the same server is
      // separate, and keeps running.
      await closeTunnel(tunnel);
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
        showsVerticalScrollIndicator
      >
        {/* The horizontal lockup: tea glass + lowercase wordmark — and the
            intended way in beside it. It sits in the title row on purpose: as
            a card above the form it pushed the Connect button under the
            keyboard on an iPhone 17, which every flow, and every person typing
            by hand, then had to scroll for. The intro already says where the
            code comes from. */}
        <View style={styles.brand}>
          <View style={styles.lockup}>
            <GreetingLogo />
            <Wordmark color={theme.fg} />
          </View>
          <Pressable
            accessibilityRole="button"
            style={styles.scan}
            onPress={() => { setError(null); setPhase("intro"); setScanning(true); }}
            disabled={busy}
            testID="scan-code"
            accessibilityHint="On the computer: herdr plugin action invoke shahi.pair"
          >
            <Text style={styles.scanText}>Scan a code</Text>
          </Pressable>
        </View>

        <SshForm ssh={ssh} patch={patch} setAuthKind={(kind) => setAuth(setSsh, kind)} />

        {error && <Text style={styles.error}>{error}</Text>}

        <Pressable
          accessibilityRole="button"
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

        <Pressable accessibilityRole="button" onPress={() => setPhase("intro")} hitSlop={12} testID="back-to-setup">
          <Text style={styles.link}>Haven't set up your computer yet?</Text>
        </Pressable>
        <PrivacyLinks licenses />
      </ScrollView>
      {/* A sheet over the form rather than in its place, so Cancel returns to
          the same scroll position with its outcome beside the Connect button.
          Swiping the sheet away is a Cancel. */}
      <Modal visible={!!hostKey} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => hostKey?.answer(false)}>
        {hostKey && <HostKeyCard review={hostKey.review} answer={hostKey.answer} />}
      </Modal>
    </KeyboardAvoidingView>
  );
}

/**
 * The relay setup guide, with SSH available as a secondary path.
 *
 * Shahi is bring-your-own-server: it shows the agents on a machine you control,
 * reached through a small helper you install once. A new user has none of that,
 * so this owns the prerequisite instead of dropping them onto a form that asks
 * for an address they do not have — the onboarding cliff. It hands over the one
 * command and opens the scanner directly once the server has printed its QR code.
 */
function Intro({ onScan, onSsh, busy, error }: { onScan: () => void; onSsh: () => void; busy: boolean; error: string | null }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await Clipboard.setStringAsync(INSTALL_COMMAND);
    committed();
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <ScrollView contentContainerStyle={styles.introBody} showsVerticalScrollIndicator>
      <View style={[styles.lockup, { marginBottom: 6 }]}>
        <GreetingLogo />
        <Wordmark color={theme.fg} />
      </View>

      <Text style={styles.lede}>Connect your computer</Text>
      <Text style={styles.introText}>
        Continue your work with Claude Code or Codex from your phone. Set up Shahi on your computer, then scan the code it shows.
      </Text>

      <Text style={styles.step}>1 — Set up your computer.</Text>
      <Pressable accessibilityRole="button" style={styles.command} onPress={() => void copy()} testID="copy-install">
        <Text style={styles.commandText} selectable>
          {INSTALL_COMMAND}
        </Text>
        <Text style={styles.copy}>{copied ? "Copied" : "Copy"}</Text>
      </Pressable>
      <Text style={styles.introText}>
        Paste these two lines into the terminal (the window where you type commands) on a Mac or Linux computer running{" "}
        <Text accessibilityRole="link" style={styles.linkInline} onPress={() => void Linking.openURL("https://herdr.dev")}>
          herdr
        </Text>
        , the app that keeps your AI assistants running. The second line shows a code to connect your phone.
      </Text>

      <Text style={styles.step}>2 — Connect your phone.</Text>
      <Text style={styles.introText}>
        Scan the code on your computer to connect securely. Keep your computer awake and connected to the internet while you use Shahi.
      </Text>

      {error && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}
      <Pressable accessibilityRole="button" style={[styles.button, busy && styles.buttonOff]} disabled={busy} onPress={onScan} testID="intro-continue">
        <Text style={styles.buttonText}>{busy ? "Pairing…" : "Scan QR code"}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" disabled={busy} onPress={onSsh} hitSlop={12} testID="use-ssh">
        <Text style={styles.link}>Want to use SSH?</Text>
      </Pressable>
      <PrivacyLinks licenses />
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
      <Text style={styles.hint}>Enter your computer’s SSH details.</Text>

      <View style={styles.row}>
        <View style={styles.grow}>
          <Text style={styles.label}>HOSTNAME OR IP ADDRESS</Text>
          <TextInput
            style={styles.input}
            value={ssh.host}
            onChangeText={(host) => patch({ host })}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            testID="ssh-host"
            placeholder="server.example.com or 192.0.2.10"
            placeholderTextColor={theme.dim}
            accessibilityLabel="SSH hostname or IP address"
          />
        </View>
        <View style={styles.port}>
          <Text style={styles.label}>PORT</Text>
          <TextInput
            style={styles.input}
            value={String(ssh.port)}
            onChangeText={(t) => patch({ port: Number(t.replace(/[^0-9]/g, "")) || 0 })}
            keyboardType="number-pad"
            inputAccessoryViewID="ssh-number-keyboard"
            testID="ssh-port"
            accessibilityLabel="SSH port"
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
        placeholder="Your computer username"
        placeholderTextColor={theme.dim}
        accessibilityLabel="SSH username"
      />

      <Text style={styles.label}>AUTH</Text>
      <View style={styles.segment}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: ssh.auth.kind === "password" }}
          style={[styles.segItem, ssh.auth.kind === "password" && styles.segItemOn]}
          onPress={() => setAuthKind("password")}
          testID="auth-password"
        >
          <Text style={[styles.segText, ssh.auth.kind === "password" && styles.segTextOn]}>Password</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: ssh.auth.kind === "key" }}
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
          accessibilityLabel="SSH password"
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
            accessibilityLabel="SSH private key"
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
            accessibilityLabel="Private key passphrase, if any"
          />
        </>
      )}

      {/* No sidecar-port field: the sidecar is always on the installer's
          default (7171), and a mass-market user should not have to know a port
          exists. `remotePort` stays at DEFAULT_SIDECAR_PORT from the profile. */}
      <Text style={styles.label}>SHAHI PASSCODE</Text>
      <TextInput
        style={[styles.input, styles.passcode]}
        value={ssh.passcode}
        onChangeText={(passcode) => patch({ passcode })}
        secureTextEntry
        keyboardType="number-pad"
            inputAccessoryViewID="ssh-number-keyboard"
        testID="ssh-passcode"
        accessibilityLabel="Shahi passcode"
      />
      {/* Only the passcode's hash is kept, and the first run shows it in the
          pair popup, not the plugin log — so "find that message again" had
          nothing to find. Replacing it is the recovery (pre-release review). */}
      {Platform.OS === "ios" && <InputAccessoryView nativeID="ssh-number-keyboard">
        <View style={{ backgroundColor: theme.surface, alignItems: "flex-end" }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Done editing SSH details" onPress={Keyboard.dismiss} style={{ minHeight: 44, minWidth: 64, justifyContent: "center", paddingHorizontal: 16 }}><Text style={{ color: theme.peach }}>Done</Text></Pressable>
        </View>
      </InputAccessoryView>}
      <Text style={styles.fieldHelp}>
        Shown once when Shahi was set up. Lost it? On the computer, run{" "}
        <Text style={styles.mono}>herdr plugin action invoke shahi.reset-passcode</Text>, then read the new one with{" "}
        <Text style={styles.mono}>herdr plugin log list --plugin shahi</Text>. Pairing by QR does not need it.
      </Text>
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.void },
  body: { flexGrow: 1, justifyContent: "center", padding: 28, gap: 10 },
  brand: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 },
  lockup: { flexDirection: "row", alignItems: "center", gap: 12 },
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
  step: { color: theme.peach, fontSize: 13, letterSpacing: 0.5, marginTop: 10 },
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
  copy: { color: theme.peach, fontSize: 13, fontWeight: "600" },
  linkInline: { color: theme.peach },
  link: { color: theme.dim, fontSize: 14, textAlign: "center", marginTop: 18, textDecorationLine: "underline" },
  label: { color: theme.dim, fontSize: 11, marginTop: 8 },
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
  fieldHelp: { color: theme.dim, fontSize: 12, lineHeight: 18, marginTop: -2 },
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
  segText: { color: theme.dim, fontSize: 13 },
  segTextOn: { color: theme.fg, fontWeight: "600" },
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
