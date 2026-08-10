# ssh-tunnel — autolinking disabled pending a prebuilt libssh2+OpenSSL

The forwarder is complete and correct: SshTunnelModule.swift + SshForwarder.m
do connect, handshake, auth (password and in-memory key via
libssh2_userauth_publickey_frommemory), and a select()-multiplexed
direct-tcpip forward. The app-side (Connect UI, Keychain, tunnel.ts, session
restore) is committed and working; without this module the app cleanly falls
back to "SSH needs the native build" and Tailscale is unaffected.

The ONLY thing unresolved is packaging libssh2 for iOS. The `libssh2-iosx`
pod builds it from source at pod-install time and is too fragile in this
toolchain — verified failures, in order: cmake missing; cmake 4.x dropped
`cmake_minimum_required(<3.5)`; two corrupt build caches; an empty-source
guard bug (`if [ ! -d libssh2-1_11_0 ]` skips cloning when a killed clone
left the dir empty); and finally its bundled OpenSSL header distribution is
incomplete (`Headers/openssl/` ships one file, `opensslv.h` missing), so
libssh2 cannot compile against it.

## To finish (deterministic path)
Vendor prebuilt binaries instead of building from source:
1. Obtain (or build once on clean CI) `libssh2.xcframework` and matching
   `OpenSSL`/`crypto`+`ssl` xcframeworks WITH complete headers, device + sim
   slices. krzyzanowskim/OpenSSL ships a complete prebuilt OpenSSL.xcframework.
2. Drop them in `modules/ssh-tunnel/ios/` and reference via
   `vendored_frameworks` in the podspec; remove the `libssh2-iosx` dependency
   and its `prepare_command` build.
3. `#import "libssh2.h"` resolves from the vendored framework's headers.
4. Rename `expo-module.config.json.disabled` back and rebuild.
This removes all pod-install-time building — no cmake, no downloads.
