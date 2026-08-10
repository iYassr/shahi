# Connecting over SSH

Shahi has two ways to reach a server. **Tailscale** is a direct address plus the
passcode — the original path, for a box on your tailnet. **SSH** is for everyone
else, which for a published app is most people: a server they already reach over
SSH, with no tailnet to set up and no sidecar port exposed to the internet.

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

## The pieces

- `src/lib/ssh.ts` — the profile type and its Keychain-safe shape.
- `src/lib/tunnel.ts` — the thin face of the native module; degrades to a clear
  "needs the native build" message where the module is absent, so Direct always
  works.
- `src/screens/connect.tsx` — the Tailscale/SSH mode switch and the form.
- `src/lib/session.tsx` — stores the profile, re-opens the tunnel on restore,
  and tears it down on sign-out.
- `modules/ssh-tunnel/` — the native forwarder. Swift (`SshTunnelModule`) owns
  the session and auth via NMSSH; Objective-C (`SshForwarder`) runs the local
  listener and splices each connection to a libssh2 direct-tcpip channel.

## Verify on device

The native module only compiles and runs in a native build, not in Metro or the
simulator's current binary — so this list is what to check after the first EAS
build that includes `modules/ssh-tunnel/`.

1. **It builds.** The two seams to watch are in `SshForwarder.m`:
   `session.rawSession` and `session.socket`. Both exist in current NMSSH; a
   linked version that renamed them is the likely cause of a build failure there.
2. **Password auth** connects to a box and the agent list fills.
3. **Key auth** with an encrypted key + passphrase connects; with an
   unencrypted key and a blank passphrase too.
4. **The WebSocket rides the tunnel** — the list updates live (LIVE, not a
   one-shot load), which proves a long-lived channel multiplexes alongside the
   HTTP polls rather than only short requests working.
5. **Cold start** re-opens the tunnel from the Keychain without asking again.
6. **Wrong password / unreachable host** surface the reason on Connect rather
   than hanging or a blank error.
7. **Sign out** drops the tunnel — no channel is left open to a box you left.
