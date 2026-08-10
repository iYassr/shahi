# ssh-tunnel — autolinking temporarily disabled

The Swift/ObjC forwarder is complete (connect + handshake + auth + direct-tcpip
forward, all libssh2). What is unresolved is *building* libssh2 for iOS under
the current Xcode toolchain: `libssh2-iosx` builds libssh2 and OpenSSL from
source, and that source build fights Xcode 26 (cmake version, nested OpenSSL
header wiring). Rename `expo-module.config.json.disabled` back to
`expo-module.config.json` and resolve the pod's iOS build to re-enable — the
cleanest path is a prebuilt libssh2+OpenSSL xcframework rather than a
from-source pod. Until then the app falls back to "SSH needs the native build"
and Tailscale works. See docs/ssh.md.
