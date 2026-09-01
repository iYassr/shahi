/**
 * The phones that paired by scanning a code, and the way to throw one out.
 *
 * A passcode login has no identity — nothing to list, nothing to revoke — and
 * the section says so rather than showing an empty list that looks like "no
 * one is signed in". Revoking asks first: the server refuses the revoked
 * phone's next request, so there is no undo. Revoking the phone you are
 * holding is a sign-out, and is labelled as one.
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import type { DeviceList, PairedDevice } from "@shahi/shared";
import { api } from "@/lib/api";
import { theme } from "@/lib/theme";

export function PairedDevices({ onRevokedSelf }: { onRevokedSelf: () => void }) {
  const [list, setList] = useState<DeviceList | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      api
        .devices()
        .then((next) => {
          setList(next);
          setError(null);
        })
        .catch((e: Error) => setError(e.message)),
    [],
  );
  useEffect(() => void load(), [load]);

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
          onPress: () =>
            void api
              .revokeDevice(device.id)
              .then(() => (self ? onRevokedSelf() : load()))
              .catch((e: Error) => setError(e.message)),
        },
      ],
    );
  };

  if (error) return <Text style={styles.note}>Couldn't read the device list: {error}</Text>;
  if (!list) return <Text style={styles.note}>Loading…</Text>;

  return (
    <View>
      {list.devices.length === 0 ? (
        <Text style={styles.note}>No phones have paired by code yet.</Text>
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
              <Pressable onPress={() => revoke(device)} hitSlop={8} testID={`revoke-${device.id}`}>
                <Text style={styles.revoke}>{device.id === list.thisDeviceId ? "Sign out" : "Revoke"}</Text>
              </Pressable>
            </View>
          </View>
        ))
      )}
      <Text style={styles.note}>
        {list.thisDeviceId === null ? "This phone signed in with the passcode. " : ""}
        Passcode sign-ins aren't devices and can't be revoked here; to sign every passcode session out at once, rotate SESSION_SECRET in the server's .env and restart.
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
});
