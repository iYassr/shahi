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
import { deleteSecret, readSecret, writeSecret } from "./keychain";
import { AccessRefusedError, HostKeyError } from "./errors";
import type { SshProfile } from "@/lib/ssh";

interface SshTunnelModule {
  /**
   * Connects and completes the SSH handshake, then disconnects. Nothing that
   * identifies the user is sent. Resolves with the server's host key: the
   * SHA-256 of its key blob (base64) and its type.
   */
  hostKey(config: { host: string; port: number }): Promise<{ hostKey: string; keyType: string }>;
  /**
   * Opens the session and the forward, resolving with the local port the
   * forward is listening on. Refuses before authenticating unless the server
   * presents exactly `expectedHostKey`. Rejects with a human-readable reason —
   * bad credentials, host unreachable, host key changed — suitable to show
   * as-is.
   */
  open(config: {
    id: string;
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKey?: string;
    passphrase?: string;
    expectedHostKey: string;
    remoteHost: string;
    remotePort: number;
  }): Promise<{ localPort: number }>;
  /** Tears down the forward and the session. Safe to call when nothing is open. */
  close(id: string | null): Promise<void>;
}

const native = requireOptionalNativeModule<SshTunnelModule>("SshTunnel");

export function sshTunnelAvailable(): boolean {
  return native != null;
}

/**
 * What a person is asked to check before this phone signs in to an SSH server
 * it does not already trust.
 */
export interface HostKeyReview {
  host: string;
  port: number;
  /** `SHA256:…`, the form `ssh-keygen -lf` prints on the server. */
  fingerprint: string;
  /** `ED25519`, `ECDSA`, `RSA`: which of the server's host keys it presented. */
  keyType: string;
  /** The fingerprint trusted before, when the key has changed since. */
  previous: string | null;
}

/** Resolves true only when the person chose to trust the key. */
export type ReviewHostKey = (review: HostKeyReview) => Promise<boolean>;

/** The person declined the key; nothing was sent to that server. */
export class HostKeyNotTrustedError extends Error {
  constructor() {
    super("Not connected. Nothing was sent to that computer.");
  }
}

/**
 * Known hosts, kept in the Keychain.
 *
 * The fingerprint this phone trusted for a host:port. The native side checks
 * it BEFORE sending credentials, so a server whose key has changed — a
 * different machine, or a man in the middle — is refused before the password
 * or key leaves the phone. A first key is trusted only after a person has
 * seen its fingerprint (`openTunnel`'s review), never silently.
 */
function knownHostKeyName(host: string, port: number): string {
  // SecureStore keys allow only [A-Za-z0-9._-]; a host:port maps into that
  // one-to-one (only the colon needs replacing), so no collisions.
  const id = `${host.trim().toLowerCase()}_${port}`.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `shahi.knownhost.${id}`;
}

/** The stored form is libssh2's base64 hash; people compare `ssh-keygen`'s. */
function fingerprint(hostKey: string): string {
  return `SHA256:${hostKey.replace(/=+$/, "")}`;
}

/**
 * Forgets the host key trusted for a removed computer, so adding it again
 * starts from a fresh review rather than a pin nothing in the app can clear.
 * Another saved login to the same host:port keeps the pin it relies on.
 */
export async function forgetHostKey(removed: SshProfile, remaining: SshProfile[]): Promise<void> {
  const name = knownHostKeyName(removed.host, removed.port);
  if (remaining.some(profile => knownHostKeyName(profile.host, profile.port) === name)) return;
  await deleteSecret(name);
}

/** Remove Expo's native-bridge envelope before a tunnel error reaches the UI. */
function tunnelFailureMessage(error: unknown): string | null {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const message = raw
    .replace(/^ssh_(?:tunnel|host_key|login|forwarding):\s*/i, "")
    .replace(/\s*\(at [^()]+\.swift:\d+\)\s*$/i, "")
    .trim();
  // Expo uses this placeholder when an Objective-C rejection has no reason.
  return message && !/^undefined(?: reason)?$/i.test(message) ? message : null;
}

function nativeFailure(error: unknown, host: string, port: number): Error {
  // The native side refused a key it was not told to trust. Its own words say
  // what to do, and a retry cannot help, so the screens must not say
  // "reconnecting" (see HostKeyError).
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ssh_host_key") {
    return new HostKeyError(tunnelFailureMessage(error) ?? `${host}:${port} did not present the host key this phone trusts, so your login was not sent.`);
  }
  // A refused login, or a server that will not forward, refuses again on
  // every retry, and a saved computer now reconnects by itself: presenting a
  // refused password every half minute is how a phone gets banned by
  // fail2ban. A native module from before the "ssh_login" code says it only
  // in words, and an over-the-air update can run on one.
  const reason = tunnelFailureMessage(error);
  if (code === "ssh_login" || code === "ssh_forwarding" || /^Authentication failed/.test(reason ?? "")) {
    return new AccessRefusedError(reason ?? `${host}:${port} refused this SSH login.`);
  }
  // Expo wraps native rejects as `ssh_tunnel: … (at Promise.swift:65)` and
  // sometimes substitutes "undefined reason". Neither is useful to someone
  // holding a phone; keep a real native reason, otherwise name what to check.
  return new Error(
    reason ??
      `Couldn't open the SSH tunnel to ${host}:${port}. Check the host, port, username, and key or password — and that the server allows this login.`,
  );
}

// Every forward has its own native id, and whoever opened it closes it by its
// base URL. Ids used to be derived from the computer, so re-adding a saved
// computer opened a forward that replaced the saved one, and disposing the
// old session then closed the new forward it had just been handed (pre-release
// review). The date keeps ids unique across a development reload.
const forwards = new Map<string, string>();
let opened = 0;

/**
 * Opens a tunnel for a profile and returns the base URL to point the client at.
 *
 * The forward always targets `127.0.0.1` on the box: the sidecar binds
 * loopback, and from the box's own point of view that is where it lives — the
 * SSH session is already "on" the box, so localhost there is the sidecar.
 *
 * With `review`, the server's key is fetched first by a handshake that sends
 * no credentials. A key this phone has not trusted for that host:port, a first
 * one or a changed one, goes to the person with its fingerprint, and the login
 * follows only if they trust it. The trusted key is saved before anything is
 * sent, and a Keychain that refuses the write stops the connection rather than
 * leaving it unpinned: the pre-release review found the first key trusted
 * silently, with the password in the same native call, and a failed write
 * reopening that window on every later connect.
 *
 * Without `review` (a saved computer reconnecting, with nobody to ask) only a
 * remembered key is accepted.
 */
export async function openTunnel(profile: SshProfile, review?: ReviewHostKey): Promise<string> {
  if (!native) {
    throw new Error(
      "SSH isn't available in this build. It needs the native tunnel module — rebuild the app to use it.",
    );
  }
  const host = profile.host.trim();
  const { port } = profile;
  const name = knownHostKeyName(host, port);
  let remembered;
  try {
    remembered = await readSecret(name);
  } catch {
    throw new Error("Couldn't read the host keys this phone trusts, so nothing was sent. Unlock the phone and try again.");
  }

  let expectedHostKey = remembered;
  if (review) {
    let presented;
    try {
      presented = await native.hostKey({ host, port });
    } catch (e) {
      throw nativeFailure(e, host, port);
    }
    if (presented.hostKey !== remembered) {
      const trusted = await review({
        host, port,
        fingerprint: fingerprint(presented.hostKey),
        keyType: presented.keyType,
        previous: remembered ? fingerprint(remembered) : null,
      });
      if (!trusted) throw new HostKeyNotTrustedError();
      try {
        await writeSecret(name, presented.hostKey);
      } catch {
        throw new Error("Couldn't save this computer's host key on the phone, so your login was not sent. Try again.");
      }
    }
    expectedHostKey = presented.hostKey;
  }
  if (!expectedHostKey) {
    throw new HostKeyError(
      `This phone has no trusted host key for ${host}:${port}, so it did not send your login. Add the computer again from Computers to check its key.`,
    );
  }

  const id = `${Date.now().toString(36)}.${++opened}`;
  let result;
  try {
    result = await native.open({
      id,
      host,
      port,
      username: profile.username.trim(),
      ...(profile.auth.kind === "password"
        ? { password: profile.auth.password }
        : { privateKey: profile.auth.privateKey, passphrase: profile.auth.passphrase }),
      expectedHostKey,
      remoteHost: "127.0.0.1",
      remotePort: profile.remotePort,
    });
  } catch (e) {
    throw nativeFailure(e, host, port);
  }
  const baseUrl = `http://127.0.0.1:${result.localPort}`;
  forwards.set(baseUrl, id);
  return baseUrl;
}

/** Closes the forward `openTunnel` returned this base URL for; anything else is a no-op. */
export async function closeTunnel(baseUrl: string): Promise<void> {
  const id = forwards.get(baseUrl);
  if (!native || !id) return;
  forwards.delete(baseUrl);
  try {
    await native.close(id);
  } catch {
    // Closing a tunnel that already died is not worth surfacing.
  }
}
