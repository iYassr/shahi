/**
 * The SSH tunnel, as the app sees it.
 *
 * This is the thin TypeScript face of the native `SshTunnel` module. It opens
 * an SSH session to the box and a local port forward through it to the sidecar,
 * and hands back a `127.0.0.1` base URL. The rest of the app points its normal
 * `fetch` and `WebSocket` at that URL and is none the wiser that an SSH channel
 * is carrying the bytes — which is the whole point: no other file has to know
 * about SSH.
 *
 * The native module only exists in a native build. In Expo Go or a build made
 * before it landed, `requireOptionalNativeModule` returns null, and we fail with
 * a message that says exactly that rather than a cryptic undefined-is-not-a-
 * function — the Direct connection path keeps working regardless.
 */
import { requireOptionalNativeModule } from "expo";
import type { SshProfile } from "@/lib/ssh";

interface SshTunnelModule {
  /**
   * Opens the session and the forward, resolving with the local port the
   * forward is listening on. Rejects with a human-readable reason — bad
   * credentials, host unreachable, key rejected — suitable to show as-is.
   */
  open(config: {
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKey?: string;
    passphrase?: string;
    remoteHost: string;
    remotePort: number;
  }): Promise<{ localPort: number }>;
  /** Tears down the forward and the session. Safe to call when nothing is open. */
  close(): Promise<void>;
}

const native = requireOptionalNativeModule<SshTunnelModule>("SshTunnel");

export function sshTunnelAvailable(): boolean {
  return native != null;
}

/**
 * Opens a tunnel for a profile and returns the base URL to point the client at.
 *
 * The forward always targets `127.0.0.1` on the box: the sidecar binds
 * loopback, and from the box's own point of view that is where it lives — the
 * SSH session is already "on" the box, so localhost there is the sidecar.
 */
export async function openTunnel(profile: SshProfile): Promise<string> {
  if (!native) {
    throw new Error(
      "SSH isn't available in this build. It needs the native tunnel module — rebuild the app to use it.",
    );
  }
  const { localPort } = await native.open({
    host: profile.host.trim(),
    port: profile.port,
    username: profile.username.trim(),
    ...(profile.auth.kind === "password"
      ? { password: profile.auth.password }
      : { privateKey: profile.auth.privateKey, passphrase: profile.auth.passphrase }),
    remoteHost: "127.0.0.1",
    remotePort: profile.remotePort,
  });
  return `http://127.0.0.1:${localPort}`;
}

export async function closeTunnel(): Promise<void> {
  if (!native) return;
  try {
    await native.close();
  } catch {
    // Closing a tunnel that already died is not worth surfacing.
  }
}
