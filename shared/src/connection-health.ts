import type { BackendState } from "./compatibility";
import { AccessRefusedError, HostKeyError, IncompatibleServerError, UnauthorizedError, UnreachableError } from "./errors";

/** The computer answered, but herdr behind it did not (`backend_unavailable`). */
export function backendUnavailable(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "backend_unavailable";
}

/** What a client shows about the link to the computer on screen. */
export interface ConnectionNotice {
  title: string;
  detail: string;
  /**
   * A reconnect that usually recovers by itself: the computer or the relay
   * did not answer, or the link is coming back. A client holds it to the
   * one-line `brief` for `RECONNECT_GRACE_MS` when the link was live or the
   * app has just come back to the foreground (`graceUntil`).
   */
  transient?: true;
  brief?: string;
}

/**
 * How long a transient reconnect stays one quiet line before the full card.
 * Measured on build 28 (October 2026): back in the foreground, the full
 * "Computer disconnected" card, with buttons into the other computers, stood
 * for about ten seconds over a computer that was fine and came back unaided.
 */
export const RECONNECT_GRACE_MS = 7_000;

/**
 * When the brief line for a transient notice gives way to the full card:
 * `previous` once it has been decided, `now` plus the grace when this notice
 * began on a link that was live or just after a resume, and 0 (at once)
 * otherwise. Null when there is nothing transient to hold back. Opening a
 * screen on a computer already gone shows the full card at once: that is not
 * a blip.
 */
export function graceUntil(previous: number | null, transient: boolean, eligible: boolean, now: number): number | null {
  if (!transient) return null;
  return previous ?? (eligible ? now + RECONNECT_GRACE_MS : 0);
}

/**
 * Only describe causes reported by the transport; silence cannot prove sleep.
 *
 * `backend` is herdr's state as the computer last reported it. The link is
 * only the socket, which stays open while herdr is stopped, so the header
 * said LIVE and an open pane showed nothing wrong until a send failed
 * (pre-release bug hunt).
 */
export function connectionHealth({ link, error, transport, online = true, computerName, backend }: {
  link: "connecting" | "live" | "lost";
  error?: Error | null;
  transport: "relay" | "ssh" | "direct";
  online?: boolean;
  computerName?: string;
  backend?: BackendState | null;
}): ConnectionNotice | null {
  const computer = computerName?.trim() || "your computer";
  const brief = `${link === "connecting" && !error ? "Connecting" : "Reconnecting"} to ${computer}…`;
  if (!online || error instanceof UnreachableError && error.reason === "offline") return {
    title: "You’re offline", detail: "Connect to Wi-Fi or mobile data. Shahi will reconnect when your network returns.",
  };
  if (error instanceof UnauthorizedError) return { title: "Access ended", detail: "Sign in again or scan a fresh pairing code from your computer." };
  if (error instanceof IncompatibleServerError) return { title: "Update needed", detail: error.message };
  // Retrying cannot help, and the refusal says what will.
  if (error instanceof HostKeyError) return { title: "Check this computer’s identity", detail: error.message };
  if (error instanceof AccessRefusedError) return { title: "Couldn’t sign in", detail: error.message };
  if (error instanceof UnreachableError && error.reason === "box") return {
    title: "Computer disconnected", detail: "Wake your computer and check that Shahi is running. We’ll keep trying to reconnect.",
    transient: true, brief,
  };
  if (error instanceof UnreachableError && error.reason === "relay") return {
    title: "Can’t reach Shahi’s relay", detail: "Check this device’s connection. We’ll keep trying; you don’t need to pair again.",
    transient: true, brief,
  };
  if (error instanceof UnreachableError && ["tls", "ats", "address"].includes(error.reason)) return {
    title: "Connection setup needs attention", detail: "Check the connection address and secure connection settings on your computer, then retry.",
  };
  if (backendUnavailable(error) || link === "live" && !error && backend?.state === "offline") return {
    title: backend?.state === "offline" ? `herdr isn’t running on ${computer}` : `herdr isn’t available on ${computer}`,
    detail: error?.message || (backend && "message" in backend && backend.message) || "Shahi will reconnect automatically when herdr is back.",
  };
  if (link === "live" && !error) return null;
  return {
    title: error || link === "lost" ? `Reconnecting to ${computer}…` : `Connecting to ${computer}…`,
    detail: transport === "ssh"
      ? "Check that your computer is awake. Retry connection will reconnect securely."
      : "Shahi will reconnect automatically. You don’t need to pair again.",
    transient: true, brief,
  };
}
