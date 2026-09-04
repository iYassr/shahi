# Connecting over SSH

Shahi has two ways to reach a server, and this is one of them. The **relay** is
the default and needs nothing configured. **SSH** is for a server you already
reach over SSH: no sidecar port exposed, and no third party in the path at all
— which is the reason to choose it over the relay.

## How it works

The app opens an SSH session to the box and forwards a local port through it to
the sidecar behind it — `ssh -L <localPort>:127.0.0.1:<sidecarPort>`. Then it
points its ordinary `fetch` and `WebSocket` at `http://127.0.0.1:<localPort>`,
and the agent list, the reader, everything, works unchanged over the tunnel. No
file outside `lib/tunnel.ts` and the Connect screen knows SSH is involved.

Credentials — a password, or a private key with a passphrase — go straight to
the iOS Keychain (SecureStore) and never leave the phone. An SSH connection
remembers the whole profile, not a base URL: the local port is a throwaway that
changes each launch, so a cold start re-opens the tunnel from the stored profile
and signs in again with the remembered passcode.

The SSH username has no safe universal default. `root` login is commonly
disabled and unnecessarily privileged; `ubuntu`, `ec2-user`, `debian`, and a
person's local account are all environment-specific. The app therefore leaves
it blank and asks for the username that already works for that server.

SSH authentication and the Shahi passcode protect different boundaries. SSH
admits the phone to the machine; the forwarded connection then arrives at the
sidecar on loopback, indistinguishable from a request made by any other local
process. Since a Shahi session can execute arbitrary terminal input, disabling
the sidecar gate for SSH would silently grant that control to every local
process that can reach its port. The passcode remains required for SSH mode.
The plugin prints it once during installation and keeps only its bcrypt hash;
recover the original installation message with
`herdr plugin log list --plugin shahi`, or deliberately rotate it with the
command in `docs/operations.md`. The normal QR pairing flow never asks for the
passcode: its single-use secret mints a revocable per-device credential instead.

## The pieces

- `src/lib/ssh.ts` — the profile type and its Keychain-safe shape.
- `src/lib/tunnel.ts` — the thin face of the native module; degrades to a clear
  "needs the native build" message where the module is absent, leaving the
  relay as the way in.
- `src/screens/connect.tsx` — the SSH form, beneath Scan a code.
- `src/lib/session.tsx` — stores the profile, re-opens the tunnel on restore,
  and tears it down on sign-out.
- `modules/ssh-tunnel/` — the native forwarder, all libssh2, no NMSSH. Swift
  (`SshTunnelModule`) marshals config; Objective-C (`SshForwarder`) connects,
  handshakes, authenticates (password or in-memory key), and runs a
  `select()`-multiplexed loop splicing each local connection to its own
  direct-tcpip channel.

## The binaries

libssh2 and OpenSSL are **vendored as prebuilt xcframeworks**
(`modules/ssh-tunnel/ios/*.xcframework`), not built from source at pod-install.
That was the hard-won lesson: the from-source `libssh2-iosx` pod failed six
different ways against this toolchain. libssh2 is compiled once against
krzyzanowskim's prebuilt `OpenSSL.xcframework` (complete headers, device +
simulator slices), and both are referenced via `vendored_frameworks` in
`SshTunnel.podspec`. No cmake, no downloads, no clone guards at build time.

To rebuild the binaries (new libssh2/OpenSSL version): see
`scratchpad/build-libssh2.sh` in the working notes — grab the OpenSSL
xcframework release, run libssh2 through cmake for `iphoneos` and
`iphonesimulator`, `xcodebuild -create-xcframework`, drop the results in
`ios/`.

## Verified

Confirmed end to end on the simulator, tunnelling to a local sshd forwarding to
the stub sidecar: SSH connect → in-memory key auth → direct-tcpip forward →
agent list over HTTP → **and the live WebSocket** (the header shows
`ssh://user@host LIVE` with real data). Password auth and cold-start
tunnel-reopen share the same path. Still worth a hand-check on a real device
against a real box before shipping.
