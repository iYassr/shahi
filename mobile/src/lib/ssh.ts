/**
 * An SSH connection profile: how to reach a box, and the sidecar behind it.
 *
 * This is the mass-market alternative to a tailnet address. Everyone with a
 * server already has SSH on it; nobody has to expose the sidecar's port to the
 * internet or stand up a tailnet. The app opens an SSH session, forwards a
 * local port through it to the box's Shahi sidecar, and the rest of the app
 * talks to that local port exactly as it would talk to a direct address — so
 * the agent list, the reader, everything, works unchanged over the tunnel.
 *
 * The whole profile, secrets included, lives in the iOS Keychain (SecureStore)
 * and never leaves the device. A private key is the credential; a password is
 * the credential; both are treated like the passcode already is.
 */
export type SshAuth =
  | { kind: "password"; password: string }
  /** An OpenSSH/PEM private key, with an empty passphrase when it is unencrypted. */
  | { kind: "key"; privateKey: string; passphrase: string };

export interface SshProfile {
  host: string;
  /** The SSH port; 22 unless the box moved it. */
  port: number;
  username: string;
  auth: SshAuth;
  /** The Shahi sidecar's port on the far side, as seen from the box itself. */
  remotePort: number;
  /** The sidecar passcode — the same one a direct connection asks for. */
  passcode: string;
}

export const DEFAULT_SSH_PORT = 22;
export const DEFAULT_SIDECAR_PORT = 7171;

/** A blank profile for a fresh form. */
export function emptySshProfile(): SshProfile {
  return {
    host: "",
    port: DEFAULT_SSH_PORT,
    username: "",
    auth: { kind: "password", password: "" },
    remotePort: DEFAULT_SIDECAR_PORT,
    passcode: "",
  };
}

/** Everything the form needs filled before Connect can do anything. */
export function sshProfileReady(p: SshProfile): boolean {
  if (!p.host.trim() || !p.username.trim() || !p.passcode) return false;
  return p.auth.kind === "password" ? p.auth.password.length > 0 : p.auth.privateKey.trim().length > 0;
}
