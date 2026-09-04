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
import * as SecureStore from "expo-secure-store";
import type { SshProfile } from "@/lib/ssh";

interface SshTunnelModule {
  /**
   * Opens the session and the forward, resolving with the local port the
   * forward is listening on and the server's host-key fingerprint. Rejects with
   * a human-readable reason — bad credentials, host unreachable, host key
   * changed — suitable to show as-is.
   */
  open(config: {
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKey?: string;
    passphrase?: string;
    expectedHostKey?: string;
    remoteHost: string;
    remotePort: number;
  }): Promise<{ localPort: number; hostKey?: string }>;
  /** Tears down the forward and the session. Safe to call when nothing is open. */
  close(): Promise<void>;
}

const native = requireOptionalNativeModule<SshTunnelModule>("SshTunnel");

export function sshTunnelAvailable(): boolean {
  return native != null;
}

/**
 * Known-hosts, trust-on-first-use, kept in the Keychain.
 *
 * The fingerprint the server presented the first time we connected, keyed by
 * host:port. The native side verifies against it BEFORE sending credentials, so
 * a server whose key has changed — a different machine, or a man in the middle —
 * is refused before the password or key leaves the phone. SecureStore keys
 * cannot contain some characters, so the host:port is hashed into the key name.
 */
function knownHostKeyName(host: string, port: number): string {
  // SecureStore keys allow only [A-Za-z0-9._-]; a host:port maps into that
  // one-to-one (only the colon needs replacing), so no collisions.
  const id = `${host.trim().toLowerCase()}_${port}`.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `shahi.knownhost.${id}`;
}

async function rememberedHostKey(host: string, port: number): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(knownHostKeyName(host, port));
  } catch {
    return null;
  }
}

async function rememberHostKey(host: string, port: number, fingerprint: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(knownHostKeyName(host, port), fingerprint);
  } catch {
    // A failed write just means we re-trust on first use next time; not fatal.
  }
}

/** Remove Expo's native-bridge envelope before a tunnel error reaches the UI. */
function tunnelFailureMessage(error: unknown): string | null {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const message = raw
    .replace(/^ssh_tunnel:\s*/i, "")
    .replace(/\s*\(at ExpoModulesCore\/Promise\.swift:\d+\)\s*$/i, "")
    .trim();
  // Expo uses this placeholder when an Objective-C rejection has no reason.
  return message && !/^undefined(?: reason)?$/i.test(message) ? message : null;
}

/**
 * Opens a tunnel for a profile and returns the base URL to point the client at.
 *
 * The forward always targets `127.0.0.1` on the box: the sidecar binds
 * loopback, and from the box's own point of view that is where it lives — the
 * SSH session is already "on" the box, so localhost there is the sidecar.
 *
 * Host-key trust-on-first-use is threaded through here: the remembered
 * fingerprint (if any) is passed down so the native side can refuse a changed
 * key before authenticating, and the fingerprint it reports back is stored the
 * first time.
 */
export async function openTunnel(profile: SshProfile): Promise<string> {
  if (!native) {
    throw new Error(
      "SSH isn't available in this build. It needs the native tunnel module — rebuild the app to use it.",
    );
  }
  const host = profile.host.trim();
  const expectedHostKey = (await rememberedHostKey(host, profile.port)) ?? undefined;

  let opened;
  try {
    opened = await native.open({
      host,
      port: profile.port,
      username: profile.username.trim(),
      ...(profile.auth.kind === "password"
        ? { password: profile.auth.password }
        : { privateKey: profile.auth.privateKey, passphrase: profile.auth.passphrase }),
      ...(expectedHostKey ? { expectedHostKey } : {}),
      remoteHost: "127.0.0.1",
      remotePort: profile.remotePort,
    });
  } catch (e) {
    // Expo wraps native rejects as `ssh_tunnel: … (at Promise.swift:65)` and
    // sometimes substitutes "undefined reason". Neither is useful to someone
    // holding a phone; keep a real native reason, otherwise name what to check.
    const msg = tunnelFailureMessage(e);
    throw new Error(
      msg
        ? msg
        : `Couldn't open the SSH tunnel to ${host}:${profile.port}. Check the host, port, username, and key or password — and that the server allows this login.`,
    );
  }
  const { localPort, hostKey } = opened;

  // First connection to this host: remember the key we just trusted, so the
  // next connection can catch a change.
  if (hostKey && !expectedHostKey) await rememberHostKey(host, profile.port, hostKey);

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
