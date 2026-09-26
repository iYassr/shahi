import { StyleSheet } from "react-native";
import { backendUnavailable, type BackendState } from "@shahi/shared";
import { Text } from "@/components/text";
import { IncompatibleServerError } from "@/lib/errors";
import { useSession } from "@/lib/session";
import { theme } from "@/lib/theme";

/** What the header says about the computer on screen, and whether that is good news. */
export function linkLabel({ link, error, backend }: {
  link: "connecting" | "live" | "lost";
  error: Error | null;
  backend?: BackendState | null;
}): { text: string; live: boolean } {
  if (error instanceof IncompatibleServerError) return { text: "UPDATE NEEDED", live: false };
  // The socket is not herdr: it stays open while herdr is stopped, and the
  // header said LIVE over a computer that could do nothing (pre-release bug
  // hunt). A request refused for that reason says so before the computer's
  // own report arrives.
  if (backendUnavailable(error) && (!backend || backend.state === "connected")) return { text: "HERDR OFFLINE", live: false };
  if (backend && backend.state !== "connected" && (link === "live" || backendUnavailable(error))) {
    return { text: backend.state === "offline" ? "HERDR OFFLINE" : "UPDATE NEEDED", live: false };
  }
  if (error && link === "live") return { text: "NOT RESPONDING", live: false };
  return link === "live" ? { text: "LIVE", live: true } : { text: link === "lost" ? "OFFLINE" : "CONNECTING", live: false };
}

/**
 * The header's word for the computer on screen.
 *
 * It reads the session itself rather than being handed `link`. A header keeps
 * the last element a screen gave it, and the Agents screen's error branch gave
 * none, so a green LIVE from before a 426 stayed above "Update needed"
 * (pre-release bug hunt).
 */
export function LinkBadge() {
  const { link, error, control } = useSession();
  const { text, live } = linkLabel({ link, error, backend: control?.handshake?.backend });
  return (
    <Text testID="link-badge" style={[styles.link, { color: live ? theme.mint : theme.peach }]} maxFontSizeMultiplier={1.2}>
      {text}
    </Text>
  );
}

const styles = StyleSheet.create({
  link: { fontFamily: theme.mono, fontSize: 11, letterSpacing: 1 },
});
