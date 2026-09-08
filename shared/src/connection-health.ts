import { IncompatibleServerError, UnauthorizedError, UnreachableError } from "./errors";

/** Only describe causes reported by the transport; silence cannot prove sleep. */
export function connectionHealth({ link, error, transport, online = true }: {
  link: "connecting" | "live" | "lost";
  error?: Error | null;
  transport: "relay" | "ssh" | "direct";
  online?: boolean;
}): { title: string; detail: string } | null {
  if (!online || error instanceof UnreachableError && error.reason === "offline") return {
    title: "You’re offline", detail: "Connect to Wi-Fi or mobile data. Shahi will reconnect when your network returns.",
  };
  if (error instanceof UnauthorizedError) return { title: "Access ended", detail: "Sign in again or scan a fresh pairing code from your computer." };
  if (error instanceof IncompatibleServerError) return { title: "Update needed", detail: error.message };
  if (error instanceof UnreachableError && error.reason === "box") return {
    title: "Computer disconnected", detail: "The relay is reachable, but your computer’s Shahi service is not connected. Wake the computer and check that herdr and Shahi are running, then retry.",
  };
  if (error instanceof UnreachableError && error.reason === "relay") return {
    title: "Relay connection unavailable", detail: "The relay refused this connection. Wait a moment, then retry.",
  };
  if (error instanceof UnreachableError && ["tls", "ats", "address"].includes(error.reason)) return {
    title: "Connection setup needs attention", detail: "Check the connection address and secure connection settings on your computer, then retry.",
  };
  if (link === "live" && !error) return null;
  return {
    title: error || link === "lost" ? "Connection interrupted" : "Connecting to your computer",
    detail: transport === "ssh"
      ? "Check your network and that the computer is awake and accepts SSH. Retry will reopen the tunnel."
      : transport === "relay"
        ? "Shahi is reconnecting through the relay. Check your network and that Shahi is running on your computer."
        : "Check your network and that Shahi or your tunnel is running. Then retry the connection.",
  };
}
