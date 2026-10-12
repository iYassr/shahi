import { UiText } from "@/components/ui-text";
import { LanguagePicker } from "@/components/language-picker";
import { useI18n } from "@/lib/i18n";
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
import { InputAccessoryView, Keyboard, Platform, KeyboardAvoidingView, Linking, Modal, Pressable, ScrollView, Share, StyleSheet, TextInput, View } from "react-native";
import { Text, useLargeText } from "@/components/text";
import * as Clipboard from "expo-clipboard";
import * as Device from "expo-device";
import { SUPPORTED_LOCALES, type PairingPayload } from "@shahi/shared";
import { createApi, UnauthorizedError, type Connection } from "@/lib/api";
import { closeRelay, pairingTarget, type RelayIdentity, type RelayTarget } from "@/lib/relay";
import { Icon, Wordmark } from "@/components/icons";
import { GreetingLogo } from "@/components/greeting-logo";
import { Scanner } from "@/components/scanner";
import { HostKeyCard } from "@/components/host-key-card";
import { PrivacyLinks } from "@/components/privacy-links";
import { parsePairingUrl } from "@/lib/pairing";
import { dismissPairing, receivePairingLink, usePendingPairing } from "@/lib/incoming-pairing";
import { openTunnel, closeTunnel, sshTunnelAvailable, type HostKeyReview } from "@/lib/tunnel";
import { committed } from "@/lib/feel";
import {
  emptySshProfile,
  sshHost,
  sshProfileReady,
  type SshProfile,
} from "@/lib/ssh";
import { theme } from "@/lib/theme";

/**
 * The one-time computer setup, the thing the intro exists to hand over: one
 * line that installs herdr when it is missing, then Shahi, and shows the QR
 * (site/install.sh). The owner asked for herdr to come with it (October 2026);
 * the two plugin commands remain for someone who already runs herdr.
 */
export const INSTALL_COMMAND = "curl -fsSL https://getshahi.dev/install | sh";
export const HERDR_COMMANDS = "herdr plugin install iYassr/shahi\nherdr plugin action invoke shahi.pair";

/**
 * Said when Paste found no pairing link. iOS answers an empty string both
 * for an empty clipboard and for a paste the person refused, so this covers
 * both. The pair command copies its link on the computer, and Universal
 * Clipboard brings it to an iPhone on the same Apple Account.
 */
export const NO_PAIRING_LINK =
  "The clipboard has no Shahi pairing link. On your computer, run herdr plugin action invoke shahi.pair: it copies one, and a Mac on your Apple Account shares it with this phone. Then paste again, and allow it if asked.";

export function Connect({
  onConnectedSsh,
  onConnectedRelay,
}: {
  /** With the connection Connect signed in on, for the saved computer to adopt. */
  onConnectedSsh: (profile: SshProfile, connection: Connection) => void;
  onConnectedRelay: (identity: RelayIdentity) => void;
}) {
  const { t: ui } = useI18n();
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
        <LanguageMenu />
        <UiText style={styles.lede} accessibilityRole="header">Pair this phone?</UiText>
        <UiText style={styles.introText}>
          A link is asking to connect this phone to a Shahi computer. Only continue if you opened this
          link yourself, from a computer you control.
        </UiText>
        <UiText style={styles.label}>RELAY</UiText>
        <Text style={styles.mono}>{host}</Text>
        <UiText style={styles.label}>COMPUTER</UiText>
        <Text style={styles.mono}>{pending.server.slice(0, 16)}…</Text>
        {failed && <UiText style={styles.error}>{failed}</UiText>}
        <Pressable
          accessibilityRole="button"
          style={[styles.button, busy && styles.buttonOff]}
          disabled={busy}
          testID="confirm-pair"
          onPress={() => {
            void pair(pending, true);
          }}
        >
          <UiText style={styles.buttonText}>{busy ? "Pairing…" : "Pair with this computer"}</UiText>
        </Pressable>
        <Pressable accessibilityRole="button" style={styles.link} onPress={() => { dismissPairing(pending); setLinkFailure(null); }} testID="confirm-cancel">
          <UiText style={styles.link}>Cancel</UiText>
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

  /**
   * A pairing link from the clipboard, for a phone that cannot scan: camera
   * access refused, or no QR in reach. Before this a refused camera left no
   * way to pair at all. The link is held exactly as an opened one is, so it
   * reaches the same "Pair this phone?" card and nothing is sent until the
   * person confirms there.
   */
  async function pasteLink() {
    setError(null);
    let text = "";
    try { text = await Clipboard.getStringAsync(); } catch { /* Read as nothing pasted. */ }
    setScanning(false);
    if (!receivePairingLink(text)) setError(NO_PAIRING_LINK);
  }

  if (scanning) {
    return (
      <Scanner
        onPaste={() => void pasteLink()}
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
    onPaste={() => void pasteLink()}
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
        <LanguageMenu />
        {/* The horizontal lockup: the s-and-glass mark + lowercase wordmark — and the
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
            accessibilityHint={ui("On the computer: herdr plugin action invoke shahi.pair")}
          >
            <UiText style={styles.scanText}>Scan a code</UiText>
          </Pressable>
        </View>

        <SshForm ssh={ssh} patch={patch} setAuthKind={(kind) => setAuth(setSsh, kind)} />

        {error && <UiText style={styles.error}>{error}</UiText>}

        <Pressable
          accessibilityRole="button"
          style={[styles.button, (busy || !canConnect) && styles.buttonOff]}
          disabled={busy || !canConnect}
          onPress={() => void connectSsh()}
          testID="connect"
        >
          <UiText style={styles.buttonText}>{busy ? "Connecting…" : "Connect"}</UiText>
        </Pressable>

        {!sshTunnelAvailable() && (
          <UiText style={styles.note}>
            SSH needs the native build of the app. Scan a pairing code instead.
          </UiText>
        )}

        <Pressable accessibilityRole="button" onPress={() => setPhase("intro")} hitSlop={12} testID="back-to-setup">
          <UiText style={styles.link}>Haven't set up your computer yet?</UiText>
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
function Intro({ onScan, onPaste, onSsh, busy, error }: { onScan: () => void; onPaste: () => void; onSsh: () => void; busy: boolean; error: string | null }) {
  const { t: ui } = useI18n();
  const [copied, setCopied] = useState(false);
  const [herdrUser, setHerdrUser] = useState(false);
  // Pinned, the footer took half the screen at AX5 and left a sliver to read
  // the steps through; at accessibility sizes it ends the scroll instead.
  const large = useLargeText();

  const copy = async () => {
    await Clipboard.setStringAsync(INSTALL_COMMAND);
    committed();
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  // The line is typed on a computer, and the person is holding a phone. Copy
  // reaches a Mac only through Universal Clipboard on the same Apple Account;
  // the share sheet reaches anything else, by AirDrop, Messages or Mail.
  const send = () => {
    void Share.share({ message: `${ui("Set up Shahi: paste this line into a terminal on your Mac or Linux computer.")}\n\n${INSTALL_COMMAND}` }).catch(() => {});
  };

  /*
   * Fresh-eyes review before the public launch (October 2026), on an iPhone 17:
   * a new person saw four language buttons first, the setup line cut off at
   * "| s", and the herdr users' commands in the middle of their path, and had
   * to scroll to find Scan QR code at all. So the language is one button, the
   * line shrinks to fit its box, the herdr commands fold away, and Scan stays
   * on screen below the steps however far they scroll.
   */
  const footer = <IntroFooter onScan={onScan} onPaste={onPaste} onSsh={onSsh} busy={busy} error={error} pinned={!large} />;
  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.introBody} showsVerticalScrollIndicator>
        <LanguageMenu leading={<View style={styles.lockup}><GreetingLogo /><Wordmark color={theme.fg} /></View>} />

        {/* Capped at twice its size: at AX5 it broke "compute / r" mid-word. */}
        <UiText style={styles.lede} accessibilityRole="header" maxFontSizeMultiplier={2}>Connect your computer</UiText>
        <UiText style={styles.introText}>
          Continue your work with Claude Code, Codex, Cursor, OpenCode or Antigravity from your phone. Set up Shahi on your computer, then scan the code it shows.
        </UiText>
        <UiText style={styles.need}>You need a Mac or Linux computer with Claude Code, Codex or another of these agents installed.</UiText>

        <View style={styles.stepCard}>
          <StepHeading number={1} title="Set up your computer" />
          <Text style={styles.introText}>{ui("Paste this line into the terminal (the window where you type commands) on a Mac or Linux computer. It installs")}{" "}
            <Text accessibilityRole="link" style={styles.linkInline} onPress={() => void Linking.openURL("https://herdr.dev")}>
              herdr
            </Text>{ui(", the app that keeps your AI assistants running, if it is missing, then Shahi, and shows a code to connect your phone." + " ")}</Text>
          {/* One line, whatever the width or text size: it shrinks to fit
              rather than wrap, because "paste this line" over two lines reads
              as two commands (build 32's lesson), and rather than scroll,
              because a sideways scroll hid the end of it. */}
          <View style={styles.command}>
            <Text style={styles.commandText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5} selectable testID="install-line">{INSTALL_COMMAND}</Text>
          </View>
          <View style={styles.commandActions}>
            <Pressable accessibilityRole="button" accessibilityLabel={copied ? ui("Copied the setup command") : ui("Copy the setup command")} style={styles.commandAction} onPress={() => void copy()} testID="copy-install">
              <Icon name={copied ? "check" : "copy"} size={16} color={theme.peach} />
              <UiText style={styles.copy}>{copied ? "Copied" : "Copy"}</UiText>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={ui("Send the setup command to your computer")} style={styles.commandAction} onPress={send} testID="share-install">
              <Icon name="share" size={16} color={theme.peach} />
              <UiText style={styles.copy}>Send to computer</UiText>
            </Pressable>
          </View>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: herdrUser }} onPress={() => setHerdrUser((v) => !v)} style={styles.disclosure} testID="herdr-user">
            <UiText style={styles.disclosureText}>Already use herdr?</UiText>
            <Icon name={herdrUser ? "chevron-up" : "chevron-down"} size={16} color={theme.dim} />
          </Pressable>
          {herdrUser && <>
            <UiText style={styles.introText}>Inside herdr, run these two lines instead:</UiText>
            <View style={styles.command}>
              {HERDR_COMMANDS.split("\n").map((line) => (
                <ScrollView key={line} horizontal showsHorizontalScrollIndicator={false} testID="herdr-line">
                  <Text style={styles.commandText} numberOfLines={1} selectable>{line}</Text>
                </ScrollView>
              ))}
            </View>
          </>}
        </View>

        <View style={styles.stepCard}>
          <StepHeading number={2} title="Connect your phone" />
          <UiText style={styles.introText}>
            Scan the code on your computer to connect securely. Keep your computer awake and connected to the internet while you use Shahi.
          </UiText>
        </View>

        {large && footer}
        <PrivacyLinks licenses />
      </ScrollView>

      {!large && footer}
    </View>
  );
}

function IntroFooter({ onScan, onPaste, onSsh, busy, error, pinned }: { onScan: () => void; onPaste: () => void; onSsh: () => void; busy: boolean; error: string | null; pinned: boolean }) {
  const { t: ui } = useI18n();
  return (
    <View style={pinned ? styles.footer : styles.footerInline}>
      {error && <UiText style={styles.error} accessibilityRole="alert">{error}</UiText>}
      <Pressable accessibilityRole="button" style={[styles.button, styles.footerButton, busy && styles.buttonOff]} disabled={busy} onPress={onScan} testID="intro-continue">
        <UiText style={styles.buttonText}>{busy ? "Pairing…" : "Scan QR code"}</UiText>
      </Pressable>
      <View style={styles.footerLinks}>
        <Pressable accessibilityRole="button" disabled={busy} onPress={onPaste} hitSlop={8} style={styles.footerLink} testID="paste-pairing-link"
          accessibilityHint={ui("Pairs with a link copied from your computer, after you confirm it")}>
          <UiText style={styles.footerLinkText}>Paste pairing link</UiText>
        </Pressable>
        <Pressable accessibilityRole="button" disabled={busy} onPress={onSsh} hitSlop={8} style={styles.footerLink} testID="use-ssh">
          <UiText style={styles.footerLinkText}>Want to use SSH?</UiText>
        </Pressable>
      </View>
    </View>
  );
}

function StepHeading({ number, title }: { number: number; title: string }) {
  return (
    <View style={styles.stepHeading}>
      <View style={styles.stepNumber}><Text style={styles.stepNumberText}>{number}</Text></View>
      <UiText style={styles.stepTitle} accessibilityRole="header">{title}</UiText>
    </View>
  );
}

/**
 * The language choice, folded behind one button: the full picker stood above
 * everything else on the welcome screen. A phone set to Arabic or Spanish
 * opens in it already ("Use device language"); this is for choosing otherwise,
 * and it names the language in its own words, so it reads to the person who
 * needs it whatever the screen is in now.
 */
function LanguageMenu({ leading }: { leading?: React.ReactNode }) {
  const { t: ui, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const current = SUPPORTED_LOCALES.find((option) => option.locale === locale)?.label ?? "English";
  return (
    <View>
      <View style={styles.menuRow}>
        {leading ?? <View />}
        <Pressable accessibilityRole="button" accessibilityLabel={ui("Language: {value1}", { value1: current })} accessibilityState={{ expanded: open }}
          onPress={() => setOpen((v) => !v)} style={styles.languageButton} testID="language-menu">
          <Icon name="globe" size={16} color={theme.dim} />
          <Text style={styles.languageText}>{current}</Text>
        </Pressable>
      </View>
      {open && <LanguagePicker />}
    </View>
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
  const { t: ui } = useI18n();
  return (
    <>
      <UiText style={styles.hint}>Enter your computer’s SSH details.</UiText>

      <View style={styles.row}>
        <View style={styles.grow}>
          <UiText style={styles.label}>HOSTNAME OR IP ADDRESS</UiText>
          <TextInput
            style={styles.input}
            value={ssh.host}
            onChangeText={(host) => patch({ host })}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            testID="ssh-host"
            placeholder={ui("server.example.com or 192.0.2.10")}
            placeholderTextColor={theme.dim}
            accessibilityLabel={ui("SSH hostname or IP address")}
          />
        </View>
        <View style={styles.port}>
          <UiText style={styles.label}>PORT</UiText>
          <TextInput
            style={styles.input}
            value={String(ssh.port)}
            onChangeText={(t) => patch({ port: Number(t.replace(/[^0-9]/g, "")) || 0 })}
            keyboardType="number-pad"
            inputAccessoryViewID="ssh-number-keyboard"
            testID="ssh-port"
            accessibilityLabel={ui("SSH port")}
          />
        </View>
      </View>

      <UiText style={styles.label}>USERNAME</UiText>
      <TextInput
        style={styles.input}
        value={ssh.username}
        onChangeText={(username) => patch({ username })}
        autoCapitalize="none"
        autoCorrect={false}
        testID="ssh-username"
        placeholder={ui("Your computer username")}
        placeholderTextColor={theme.dim}
        accessibilityLabel={ui("SSH username")}
      />

      <UiText style={styles.label}>AUTH</UiText>
      <View style={styles.segment}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: ssh.auth.kind === "password" }}
          style={[styles.segItem, ssh.auth.kind === "password" && styles.segItemOn]}
          onPress={() => setAuthKind("password")}
          testID="auth-password"
        >
          <UiText style={[styles.segText, ssh.auth.kind === "password" && styles.segTextOn]}>Password</UiText>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: ssh.auth.kind === "key" }}
          style={[styles.segItem, ssh.auth.kind === "key" && styles.segItemOn]}
          onPress={() => setAuthKind("key")}
          testID="auth-key"
        >
          <UiText style={[styles.segText, ssh.auth.kind === "key" && styles.segTextOn]}>Key</UiText>
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
          placeholder={ui("password")}
          placeholderTextColor={theme.dim}
          accessibilityLabel={ui("SSH password")}
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
            placeholder={ui("-----BEGIN OPENSSH PRIVATE KEY-----")}
            placeholderTextColor={theme.dim}
            accessibilityLabel={ui("SSH private key")}
          />
          <UiText style={styles.label}>PASSPHRASE (IF ANY)</UiText>
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
            accessibilityLabel={ui("Private key passphrase, if any")}
          />
        </>
      )}

      {/* No sidecar-port field: the sidecar is always on the installer's
          default (7171), and a mass-market user should not have to know a port
          exists. `remotePort` stays at DEFAULT_SIDECAR_PORT from the profile. */}
      <UiText style={styles.label}>SHAHI PASSCODE</UiText>
      <TextInput
        style={[styles.input, styles.passcode]}
        value={ssh.passcode}
        onChangeText={(passcode) => patch({ passcode })}
        secureTextEntry
        keyboardType="number-pad"
            inputAccessoryViewID="ssh-number-keyboard"
        testID="ssh-passcode"
        accessibilityLabel={ui("Shahi passcode")}
      />
      {/* Only the passcode's hash is kept, and the first run shows it in the
          pair popup, not the plugin log — so "find that message again" had
          nothing to find. Replacing it is the recovery (pre-release review). */}
      {Platform.OS === "ios" && <InputAccessoryView nativeID="ssh-number-keyboard">
        <View style={{ backgroundColor: theme.surface, alignItems: "flex-end" }}>
          <Pressable accessibilityRole="button" accessibilityLabel={ui("Done editing SSH details")} onPress={Keyboard.dismiss} style={{ minHeight: 44, minWidth: 64, justifyContent: "center", paddingHorizontal: 16 }}><UiText style={{ color: theme.peach }}>Done</UiText></Pressable>
        </View>
      </InputAccessoryView>}
      <Text style={styles.fieldHelp}>{ui("Shown once when Shahi was set up. Lost it? On the computer, run")}{" "}
        <Text style={styles.mono}>herdr plugin action invoke shahi.reset-passcode</Text>{ui(", then read the new one with")}{" "}
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
  introBody: { flexGrow: 1, padding: 24, paddingBottom: 16, gap: 14 },
  lede: { color: theme.fg, fontSize: 24, fontWeight: "600", lineHeight: 31, marginTop: 8 },
  introText: { color: theme.dim, fontSize: 15, lineHeight: 22 },
  need: { color: theme.fg, fontSize: 14, lineHeight: 20 },
  menuRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  languageButton: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: theme.line },
  languageText: { color: theme.dim, fontSize: 14 },
  stepCard: { gap: 12, padding: 16, borderRadius: 14, borderCurve: "continuous", borderWidth: 1, borderColor: theme.line, backgroundColor: theme.surface },
  stepHeading: { flexDirection: "row", alignItems: "center", gap: 10 },
  stepNumber: { width: 26, height: 26, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: theme.peach },
  stepNumberText: { color: theme.void, fontSize: 14, fontWeight: "700" },
  stepTitle: { color: theme.fg, fontSize: 17, fontWeight: "600", flexShrink: 1 },
  command: {
    direction: "ltr",
    gap: 6,
    backgroundColor: theme.void,
    borderWidth: 1,
    borderColor: theme.lineBright,
    borderRadius: 10,
    borderCurve: "continuous",
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  commandText: { color: theme.fg, fontFamily: theme.mono, fontSize: 13, lineHeight: 18 },
  commandActions: { flexDirection: "row", gap: 10 },
  commandAction: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, minHeight: 44, borderRadius: 10, borderCurve: "continuous", borderWidth: 1, borderColor: theme.peach },
  copy: { color: theme.peach, fontSize: 14, fontWeight: "600" },
  disclosure: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44 },
  disclosureText: { color: theme.dim, fontSize: 14, textDecorationLine: "underline" },
  footer: { paddingHorizontal: 24, paddingTop: 12, paddingBottom: 8, gap: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line, backgroundColor: theme.void },
  footerInline: { gap: 4 },
  footerButton: { marginTop: 0 },
  footerLinks: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", columnGap: 20 },
  footerLink: { minHeight: 44, justifyContent: "center" },
  footerLinkText: { color: theme.dim, fontSize: 14, textDecorationLine: "underline" },
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
  buttonText: { color: theme.void, fontWeight: "600", fontSize: 16, textAlign: "center" },
});
