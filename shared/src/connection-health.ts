import { HostKeyError, IncompatibleServerError, UnauthorizedError, UnreachableError } from "./errors";

/** Only describe causes reported by the transport; silence cannot prove sleep. */
export function connectionHealth({ link, error, transport, online = true, computerName }: {
  link: "connecting" | "live" | "lost";
  error?: Error | null;
  transport: "relay" | "ssh" | "direct";
  online?: boolean;
  computerName?: string;
}): { title: string; detail: string } | null {
  const computer = computerName?.trim() || "your computer";
  if (!online || error instanceof UnreachableError && error.reason === "offline") return {
    title: "You’re offline", detail: "Connect to Wi-Fi or mobile data. Shahi will reconnect when your network returns.",
  };
  if (error instanceof UnauthorizedError) return { title: "Access ended", detail: "Sign in again or scan a fresh pairing code from your computer." };
  if (error instanceof IncompatibleServerError) return { title: "Update needed", detail: error.message };
  // Retrying cannot help, and the refusal says what will.
  if (error instanceof HostKeyError) return { title: "Check this computer’s identity", detail: error.message };
  if (error instanceof UnreachableError && error.reason === "box") return {
    title: "Computer disconnected", detail: "Wake your computer and check that Shahi is running. We’ll keep trying to reconnect.",
  };
  if (error instanceof UnreachableError && error.reason === "relay") return {
    title: "Connection temporarily unavailable", detail: "Shahi cannot connect right now. We’ll keep trying; you don’t need to pair again.",
  };
  if (error instanceof UnreachableError && ["tls", "ats", "address"].includes(error.reason)) return {
    title: "Connection setup needs attention", detail: "Check the connection address and secure connection settings on your computer, then retry.",
  };
  if (link === "live" && !error) return null;
  return {
    title: error || link === "lost" ? `Reconnecting to ${computer}…` : `Connecting to ${computer}…`,
    detail: transport === "ssh"
      ? "Your conversation stays open. Check that your computer is awake. Retry connection will reconnect securely."
      : "Your conversation stays open while Shahi reconnects. You don’t need to pair again.",
  };
}
