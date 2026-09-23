/**
 * The phones that paired by scanning a code, and the way to throw one out.
 *
 * A passcode login has no identity — nothing to list, nothing to revoke — and
 * the section says so rather than showing an empty list that looks like "no
 * one is signed in". Revoking asks first: the server refuses the revoked
 * phone's next request, so there is no undo. Revoking the phone you are
 * holding is a sign-out, and is labelled as one.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/components/text";
import type { DeviceList, PairedDevice } from "@shahi/shared";
import type { Api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { theme } from "@/lib/theme";

export function PairedDevices({
  onRevokedSelf,
  focused,
  live,
}: {
  onRevokedSelf: () => void;
  /** Whether the screen showing the list is on screen. */
  focused: boolean;
  /** Whether the link is live, so a list that failed while it was down is read again once it is back. */
  live: boolean;
}) {
  const { api, activeComputerId } = useSession();
  // Switching computers must discard the old list and any pending confirmations.
  return <DeviceListForComputer key={activeComputerId} api={api} onRevokedSelf={onRevokedSelf} focused={focused} live={live} />;
}

function DeviceListForComputer({ api, onRevokedSelf, focused, live }: {
  api: Api; onRevokedSelf: () => void; focused: boolean; live: boolean;
}) {
  const mounted = useRef(true);
  const request = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current++; }; }, []);
  const [list, setList] = useState<DeviceList | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const generation = ++request.current;
    try {
      const next = await api.devices();
      if (!mounted.current || generation !== request.current) return;
      setList(next);
      setError(null);
    } catch (e) {
      if (mounted.current && generation === request.current) setError((e as Error).message);
    }
  }, [api]);
  /*
   * Read when the list comes on screen, and again when the link comes back
   * while it is. Nothing else: Settings is mounted with the other tabs at
   * launch, and keying the read on every link state change cost 22 reads of
   * /api/devices in one 32-second simulator run, most of them for a screen
   * nobody was looking at (September 2026 review).
   */
  const seen = useRef({ focused: false, live });
  useEffect(() => {
    const before = seen.current;
    seen.current = { focused, live };
    if (focused && (!before.focused || (live && !before.live))) void load();
  }, [focused, live, load]);

  const revoke = (device: PairedDevice) => {
    const self = device.id === list?.thisDeviceId;
    Alert.alert(
      self ? "Sign this phone out?" : `Revoke ${device.name}?`,
      self
        ? "This phone will need a new code to get back in."
        : `${device.name} loses access immediately. It can pair again with a new code.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: self ? "Sign out" : "Revoke",
          style: "destructive",
          onPress: () => {
            if (!mounted.current) return;
            void api
              .revokeDevice(device.id)
              .then(() => { if (mounted.current) return self ? onRevokedSelf() : load(); })
              .catch((e: Error) => { if (mounted.current) setError(e.message); });
          },
        },
      ],
    );
  };

  if (error) {
    return (
      <View style={styles.retryBlock}>
        <Text style={styles.note}>Couldn't read the device list: {error}</Text>
        <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.retry} testID="retry-devices">
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      </View>
    );
  }
  if (!list) return <Text style={styles.note}>Loading…</Text>;

  return (
    <View>
      {list.devices.length === 0 ? (
        <Text style={styles.note}>No devices have paired by code yet.</Text>
      ) : (
        list.devices.map((device, i) => (
          <View key={device.id}>
            {i > 0 && <View style={styles.separator} />}
            <View style={styles.row} testID={`device-${device.id}`}>
              <View style={styles.body}>
                <Text style={styles.name} numberOfLines={1}>
                  {device.name}
                  {device.id === list.thisDeviceId ? <Text style={styles.self}> · this phone</Text> : null}
                </Text>
                <Text style={styles.sub}>
                  paired {relative(device.createdAt)} · seen {relative(device.lastSeenAt)}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={device.id === list.thisDeviceId ? `Sign out ${device.name}` : `Revoke ${device.name}`}
                onPress={() => revoke(device)}
                hitSlop={8}
                testID={`revoke-${device.id}`}
              >
                <Text style={styles.revoke}>{device.id === list.thisDeviceId ? "Sign out" : "Revoke"}</Text>
              </Pressable>
            </View>
          </View>
        ))
      )}
      <Text style={styles.note}>
        {list.thisDeviceId === null
          ? "This phone signed in with a passcode. Use Sign out below to disconnect it. "
          : "Only devices connected with a pairing code appear here. "}
        Removing a device ends its access to this computer.
      </Text>
    </View>
  );
}

/** "just now", "5m ago", "3h ago", "2d ago" — enough to tell a live phone from a forgotten one. */
export function relative(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  body: { flex: 1, gap: 2 },
  name: { color: theme.fg, fontSize: 15 },
  self: { color: theme.mint, fontFamily: theme.mono, fontSize: 12 },
  sub: { color: theme.dim, fontFamily: theme.mono, fontSize: 11 },
  revoke: { color: theme.rose, fontSize: 14, fontWeight: "600", minHeight: 32, lineHeight: 32 },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: theme.line, marginLeft: 12 },
  note: { color: theme.dim, fontSize: 12, lineHeight: 17, paddingHorizontal: 12, paddingVertical: 10 },
  retryBlock: { paddingBottom: 10 },
  retry: { minHeight: 44, justifyContent: "center", paddingHorizontal: 12 },
  retryText: { color: theme.peach, fontSize: 14, fontWeight: "600" },
});
