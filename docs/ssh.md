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
The plugin prints it once, when it first sets Shahi up, and keeps only its
bcrypt hash. Where it was printed depends on what did the setup: the pair popup
shows it on screen, and the startup hook writes it to
`herdr plugin log list --plugin shahi`. A lost passcode is replaced, not
recovered: `herdr plugin action invoke shahi.reset-passcode` prints a new one
to that same log and restarts the sidecar, without signing out existing
sessions or paired phones. The normal QR pairing flow never asks for the
passcode: its single-use secret mints a revocable per-device credential instead.

The forward can use any local port: the sidecar accepts a request whose `Host`
is `127.0.0.1`, `localhost` or `[::1]`, with any port, which is what `ssh -L`
and the app's tunnel send. A name of your own for the forward (an
`/etc/hosts` alias) is refused with 403 unless it is listed in
`SHAHI_ALLOWED_HOSTS`, because that check is what stops a DNS-rebinding page
from reaching the port. The app's tunnel always connects to the sidecar's
default port, 7171; the SSH form has no port field, so a sidecar moved with
`PORT=` in its `.env` cannot be reached from the app over SSH.

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
different ways against this toolchain (cmake missing, cmake 4 dropping old
policies, two corrupt build caches, an empty-clone guard, and a bundled OpenSSL
without `opensslv.h`). Both are referenced via `vendored_frameworks` in
`SshTunnel.podspec`. No cmake, no downloads, no clone guards at build time.
Both were added once, in `cfd06cf` (2026-08-10), and have not changed since.
Their license texts are in `modules/ssh-tunnel/licenses/`.

Where each came from, as far as it can be established:

- **OpenSSL 3.6.3** (`OpenSSL.xcframework`, a dynamic framework CocoaPods
  embeds and signs) is krzyzanowskim/OpenSSL release `3.6.3000`, unmodified
  except that the upstream `dSYMs` folders were dropped. That was checked on
  2026-09-02: both iOS slices are byte-identical to that release's
  `OpenSSL.xcframework.zip`, and the zip's SHA-256 and the slices' hashes are
  recorded in `mobile/src/lib/ssh-binaries.pentest.test.ts`, which fails if
  either slice changes.
- **libssh2 1.11.0** (`libssh2.xcframework`, static archives for `ios-arm64`
  and an arm64-only simulator slice) was compiled once, on the author's Mac,
  with cmake against that OpenSSL, for `iphoneos` and `iphonesimulator`, and
  combined with `xcodebuild -create-xcframework`. The script that did it,
  `scratchpad/build-libssh2.sh`, lived in the author's working notes, was never
  committed, and no longer exists; the exact cmake options were not recorded
  anywhere else. **These archives cannot be reproduced from this repository.**
  The same test pins their SHA-256s, so a swapped archive is a red test rather
  than an invisible one, and records what the build contains: libssh2's own
  algorithm order, AES-GCM ahead of every CBC cipher, and no strict-kex
  (that arrived in 1.11.1).

To move to a newer libssh2, rebuild it the same way — the OpenSSL release as
is, libssh2 through cmake for both SDKs, `xcodebuild -create-xcframework` —
then commit the build script with the result, update the hashes in the pentest
test, and replace the license files. libssh2 1.11.1 and later put
`chacha20-poly1305@openssh.com` first in their cipher table, a mode Terrapin
(CVE-2023-48795) can attack where strict-kex is not negotiated, so pin method
preferences in `SshForwarder.m` when you do; the test explains why.

## Verified

Confirmed end to end on the simulator, tunnelling to a local sshd forwarding to
the stub sidecar: SSH connect → in-memory key auth → direct-tcpip forward →
agent list over HTTP → **and the live WebSocket** (the header shows
`ssh://user@host LIVE` with real data). Password auth and cold-start
tunnel-reopen share the same path. Still worth a hand-check on a real device
against a real box before shipping.
