import { ComputerUpdate } from "@/components/computer-update";
import { ConnectionHealth } from "@/components/connection-health";
/**
 * Settings, in the settings grammar everyone already knows: an identity card
 * up top, then inset-grouped sections of icon-led rows, the way out in red
 * at the bottom.
 *
 * The identity here is the server, not a person — this app has no account,
 * it has a machine you trust. Signing out was unreachable before this
 * screen existed; switching servers meant deleting the app. Diagnostics
 * carries the one number that tells a frozen screen from a dead link: how
 * long ago the last update arrived.
 */
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text, useLargeText } from "@/components/text";
import Constants from "expo-constants";
import { router, Stack, useIsFocused } from "expo-router";
import { preparePushLogout } from "@/lib/push-registration";
import { enablePush } from "@/lib/push";
import { useSession, useLastUpdate } from "@/lib/session";
import { theme } from "@/lib/theme";
import { Icon, type IconName } from "@/components/icons";
import { PairedDevices } from "@/components/paired-devices";
import { PrivacyLinks } from "@/components/privacy-links";

const TERMINAL_WIDTHS = [60, 100, 146];

export function Settings() {
  const { api, session, link, signOut, pins, clearPins, terminalWidth, setTerminalWidth, server } =
    useSession();
  const lastUpdateAt = useLastUpdate();
  const [signingOut, setSigningOut] = useState(false);
  const [push, setPush] = useState<"off" | "asking" | "on" | string>("off");
  // Native tabs mount every tab at launch, so this screen exists long before
  // anyone looks at it. Work that only matters on screen waits for focus.
  const focused = useIsFocused();
  // A ticking "how stale" readout; only this screen pays for the timer, and
  // only while it is showing.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!focused) return;
    const timer = setInterval(() => tick((n) => n + 1), 1_000);
    return () => clearInterval(timer);
  }, [focused]);

  const age =
    lastUpdateAt === null ? null : Math.max(0, Math.round((Date.now() - lastUpdateAt) / 1000));
  // Any scheme, not just http: the reach is written `relay://…` or `ssh://…`,
  // and only the http form was being stripped, so the fallback name showed the
  // whole URL.
  const host = server.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "") || "—";
  // How the phone reaches the box, not the box itself: over SSH the address is
  // the machine, over the relay it is the relay's host. So name the box by its
  // own hostname (from the authenticated snapshot) and keep the reach — the
  // relay URL or ssh target — behind a tap.
  const isSsh = server.startsWith("ssh://");
  const kind = isSsh ? "ssh" : "shahi relay";
  const name = session?.serverName ?? host;
  const status = link === "live" ? "Connected" : link === "lost" ? "Offline" : "Connecting…";
  const [showReach, setShowReach] = useState(false);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={styles.screen}
      contentContainerStyle={styles.content}
    >
      {/* A see-through bar at the scroll edge, so the large title shows.
          On iOS 27 UIKit hosts this screen's large title inside the scroll
          view rather than the bar (read from the simulator's view hierarchy;
          Agents and Spaces keep theirs in the bar), and the tab stack's opaque
          scroll-edge background then covered it: "Settings" was a blank band
          until you scrolled (September 2026 review). Giving Settings the other
          tabs' header items, or wrapping its scroll view as theirs are, did
          not move the title. See-through at the scroll edge is also iOS's own
          default; the screen behind is the same colour, and content scrolled
          under the bar still gets the opaque standard bar. */}
      <Stack.Screen options={{ headerLargeStyle: { backgroundColor: "transparent" } }} />
      {/* The server is the identity: where WhatsApp puts your face, this app
          puts the machine you are trusting. Tap to reveal how it is reached. */}
      <ConnectionHealth />
      <View style={styles.group}>
        <Pressable
          style={styles.profile}
          testID="server-identity"
          onPress={() => setShowReach((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel={`${name}, ${status}. Connection details${showReach ? `. ${isSsh ? "SSH connection" : "Encrypted relay connection"}. ${server}${session ? `. herdr ${session.version}` : ""}` : ""}`}
          accessibilityState={{ expanded: showReach }}
          accessibilityHint="Show or hide connection details"
        >
          <View style={styles.profileIcon}>
            <Icon name="server" color={theme.peach} size={26} />
          </View>
          <View style={styles.profileBody}>
            <Text style={styles.profileName} numberOfLines={1}>
              {name}
            </Text>
            <Text style={styles.profileSub} numberOfLines={1}>
              {status}
            </Text>
            <Text style={{ color: theme.peach, fontSize: 13, marginTop: 6 }}>Connection details</Text>
            {showReach && (
              <Text style={styles.profileReach} selectable>
                {kind === "ssh" ? "SSH connection" : "Encrypted relay connection"}{"\n"}{server}
                {session ? ` · herdr ${session.version} · protocol ${session.protocol}` : ""}
              </Text>
            )}
          </View>
          <Icon name={showReach ? "chevron-up" : "chevron-down"} color={theme.dim} size={16} />
        </Pressable>
        <Separator />
        <Row icon="server" tint={theme.peach} label="Computers" value="Switch or add" onPress={() => router.push("/computers")} />
      </View>

      <ComputerUpdate settings />
      <View style={styles.group}>
        <Row
          icon={push === "on" ? "bell" : "bell-off"}
          tint={push === "on" ? theme.mint : theme.peach}
          label="Notifications"
          value={push === "on" ? "On" : push === "asking" ? "Asking…" : "Off"}
          disabled={push === "asking" || push === "on"}
          onPress={() => {
            setPush("asking");
            void enablePush(api).then((r) => setPush(r.ok ? "on" : r.reason));
          }}
          hint={
            push !== "off" && push !== "on" && push !== "asking"
              ? push
              : "Get notified when an agent needs your reply."
          }
        />
        <Separator />
        <View style={styles.row}>
          <View style={styles.rowLine}>
            <IconBadge name="terminal" tint={theme.mint} />
            <Text style={styles.rowLabel}>Terminal width</Text>
          </View>
          <View style={styles.widths}>
            {TERMINAL_WIDTHS.map((w) => (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: w === terminalWidth }}
                key={w}
                style={[styles.width, w === terminalWidth && styles.widthOn]}
                onPress={() => setTerminalWidth(w)}
              >
                <Text style={[styles.widthText, w === terminalWidth && styles.widthTextOn]}>
                  {w === 146 ? "fit" : `${w}c`}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
        <Separator />
        <Row
          icon="pin"
          tint={theme.peach}
          label="Pinned conversations"
          value={pins.size > 0 ? `Clear ${pins.size}` : "None"}
          disabled={pins.size === 0}
          onPress={clearPins}
        />
      </View>

      {/* Who else is in. Only phones that paired by code have an identity to
          list; the section says so for a passcode login. Revoking the phone in
          hand is a sign-out, so it leaves the same way the red row does. */}
      <View style={styles.group}>
        <View style={styles.row}>
          <View style={styles.rowLine}>
            <IconBadge name="server" tint={theme.peach} />
            <Text style={styles.rowLabel}>Devices with access</Text>
          </View>
        </View>
        <Separator />
        <PairedDevices
          focused={focused}
          live={link === "live"}
          onRevokedSelf={() => {
            signOut();
            router.replace("/connect");
          }}
        />
      </View>

      <View style={styles.group}>
        <Row
          icon="activity"
          tint={age !== null && age > 15 ? theme.peach : theme.mint}
          label="Last update"
          value={age === null ? "never" : `${age}s ago`}
        />
        <Separator />
        <Row icon="info" tint={theme.dim} label="App" value={Constants.expoConfig?.version ?? "dev"} />
      </View>

      <View style={styles.group}>
        <Row
          icon="log-out"
          tint={theme.rose}
          label={signingOut ? "Signing out…" : "Sign out"}
          disabled={signingOut}
          labelColor={theme.rose}
          onPress={() =>
            Alert.alert(
              "Sign out of this computer?",
              "You will need a new pairing code or your SSH details to reconnect to this computer. Other saved computers stay available.",
              [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Sign out",
                  style: "destructive",
                  onPress: async () => {
                    setSigningOut(true);
                    try {
                      // Revoke server-side push subscriptions while the authenticated
                      // transport is still open, then discard local credentials.
                      await preparePushLogout(api);
                      await api.logout();
                    } catch {
                      // An offline box cannot prevent local sign-out.
                    } finally {
                      signOut();
                      router.replace("/connect");
                    }
                  },
                },
              ],
            )
          }
        />
      </View>
      <PrivacyLinks />
    </ScrollView>
  );
}

function IconBadge({ name, tint }: { name: IconName; tint: string }) {
  return (
    <View style={styles.badge}>
      <Icon name={name} color={tint} size={15} />
    </View>
  );
}

function Separator() {
  return <View style={styles.separator} />;
}

function Row({
  icon,
  tint,
  label,
  labelColor,
  value,
  hint,
  disabled,
  onPress,
}: {
  icon: IconName;
  tint: string;
  label: string;
  labelColor?: string;
  value?: string;
  hint?: string;
  disabled?: boolean;
  onPress?: () => void;
}) {
  // At accessibility sizes the value goes under the label. Side by side, the
  // value kept its full width and the flexible label was left a few points:
  // AX5 on the simulator drew "Computers" one letter per line beside "Switch
  // or add" (September 2026 review).
  const largeText = useLargeText();
  const body = (
    <>
      <View style={styles.rowLine}>
        <IconBadge name={icon} tint={tint} />
        <View style={[styles.rowText, largeText && styles.rowTextStacked]}>
          <Text style={[styles.rowLabel, largeText && { flex: 0 }, labelColor ? { color: labelColor } : null]}>{label}</Text>
          {value ? <Text style={styles.rowValue}>{value}</Text> : null}
        </View>
      </View>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </>
  );
  if (!onPress) return <View style={styles.row}>{body}</View>;
  return (
    <Pressable accessibilityRole="button" style={styles.row} disabled={disabled} onPress={onPress}>
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.void },
  // The native tab bar floats over content. Keep the destructive final row
  // fully visible and tappable above it, including at large text sizes.
  content: { paddingBottom: 112 },
  // The inset-grouped card, the way iOS settings sections sit on the page.
  group: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.line,
    borderRadius: 14,
    borderCurve: "continuous",
    marginHorizontal: 16,
    marginTop: 16,
    overflow: "hidden",
  },
  profile: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14 },
  profileIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: 1,
    borderColor: theme.peach,
    backgroundColor: theme.void,
    alignItems: "center",
    justifyContent: "center",
  },
  profileBody: { flex: 1, gap: 2 },
  profileName: { color: theme.fg, fontSize: 15, fontWeight: "700" },
  profileSub: { color: theme.dim, fontFamily: theme.mono, fontSize: 10.5 },
  profileReach: { color: theme.dim, fontFamily: theme.mono, fontSize: 10.5, marginTop: 3, opacity: 0.85 },

  row: { paddingHorizontal: 12, paddingVertical: 10, gap: 6 },
  rowLine: { flexDirection: "row", alignItems: "center", gap: 10 },
  badge: {
    width: 28,
    height: 28,
    borderRadius: 7,
    borderCurve: "continuous",
    backgroundColor: theme.raised,
    alignItems: "center",
    justifyContent: "center",
  },
  rowText: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10 },
  rowTextStacked: { flexDirection: "column", alignItems: "flex-start", gap: 2 },
  rowLabel: { color: theme.fg, fontSize: 15, flex: 1 },
  rowValue: { color: theme.dim, fontSize: 12 },
  hint: { color: theme.dim, fontSize: 12, paddingLeft: 38 },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: theme.line, marginLeft: 50 },

  widths: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingLeft: 38 },
  width: {
    borderWidth: 1,
    borderColor: theme.line,
    borderRadius: 999,
    paddingHorizontal: 12,
    minHeight: 32,
    justifyContent: "center",
  },
  widthOn: { borderColor: theme.lineBright, backgroundColor: theme.raised },
  widthText: { color: theme.dim, fontSize: 12 },
  widthTextOn: { color: theme.fg },
});
