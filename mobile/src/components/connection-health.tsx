import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/components/text";
import { connectionHealth, graceUntil, RECONNECT_GRACE_MS } from "@shahi/shared";
import { useSession } from "@/lib/session";
import { theme } from "@/lib/theme";
import { OtherComputers } from "./other-computers";

/**
 * When the app last came back to the foreground. A reconnect met then is the
 * one that recovers by itself, so it gets the brief line (`graceUntil`) even
 * on a screen opened since, which never saw the link live.
 */
let resumedAt = 0;
/** Records a return to the foreground; the AppState listener below calls it. */
export function markResumed(at = Date.now()) { resumedAt = at; }
AppState.addEventListener?.("change", (state) => { if (state === "active") markResumed(); });

export function ConnectionHealth({ conversation = false }: { conversation?: boolean }) {
  const session = useSession();
  return <ComputerHealth key={session.activeComputerId ?? "current"} session={session} conversation={conversation} />;
}

function ComputerHealth({ session, conversation }: { session: ReturnType<typeof useSession>; conversation: boolean }) {
  const { link, error, server, reconnect, online = true, activeComputerId, computers, control } = session;
  // An unnamed computer is "your computer" in a sentence, not "Your computer".
  const current = computers?.find(computer => computer.id === activeComputerId);
  const computerName = current?.named === false ? undefined : current?.name;
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState<Error | null>(null);
  const health = connectionHealth({ link, online, computerName, error: error ?? (link === "live" ? null : retryError), transport: server?.startsWith("ssh:") ? "ssh" : "relay", backend: control?.handshake?.backend });
  // Decided once per drop, during render so the first frame is already right.
  const seenLive = useRef(link === "live");
  if (link === "live") seenLive.current = true;
  const until = useRef<number | null>(null);
  const now = Date.now();
  until.current = graceUntil(until.current, !!health?.transient, seenLive.current || now - resumedAt < RECONNECT_GRACE_MS, now);
  const brief = !!health?.transient && until.current! > now;
  const [, escalate] = useState(0);
  useEffect(() => {
    if (!brief) return;
    const timer = setTimeout(() => escalate(n => n + 1), Math.max(0, until.current! - Date.now()));
    return () => clearTimeout(timer);
  }, [brief]);
  if (!health) return null;
  if (brief) return <View style={styles.brief} testID="connection-brief" accessibilityLiveRegion="polite">
    <ActivityIndicator size="small" color={theme.dim} />
    <Text style={styles.briefText}>{health.brief}</Text>
  </View>;
  return <View style={styles.card} accessibilityLiveRegion="polite">
    <Text style={styles.title}>{health.title}</Text>
    <Text style={styles.detail}>{health.detail}</Text>
    {conversation && <Text style={styles.note}>Your draft stays here. Nothing is sent automatically.</Text>}
    <OtherComputers />
    <View style={styles.actions}>
    <Pressable testID="switch-computer" accessibilityRole="button" style={styles.retry} onPress={() => router.push("/computers")}>
      <Text style={styles.action}>Switch computer</Text>
    </Pressable>
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy || !online }} disabled={busy || !online} style={styles.retry} onPress={() => {
      setBusy(true); setRetryError(null);
      void reconnect().catch((e) => setRetryError(e instanceof Error ? e : new Error("Connection failed"))).finally(() => setBusy(false));
    }}><Text style={styles.action}>{busy ? "Retrying…" : "Retry connection"}</Text></Pressable>
    </View>
  </View>;
}
const styles = StyleSheet.create({
  card: { marginHorizontal: 16, marginVertical: 8, padding: 14, gap: 6, backgroundColor: theme.surface, borderColor: theme.line, borderWidth: 1, borderRadius: 12 },
  brief: { marginHorizontal: 16, marginVertical: 6, paddingHorizontal: 4, minHeight: 28, flexDirection: "row", alignItems: "center", gap: 8 },
  briefText: { color: theme.dim, fontSize: 13, flexShrink: 1 },
  title: { color: theme.peach, fontWeight: "600", fontSize: 15 },
  detail: { color: theme.fg, fontSize: 14, lineHeight: 20 },
  note: { color: theme.dim, fontSize: 12, lineHeight: 18 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  retry: { minHeight: 44, justifyContent: "center", alignSelf: "flex-start", paddingHorizontal: 8 },
  action: { color: theme.peach, fontWeight: "600", fontSize: 14 },
});
