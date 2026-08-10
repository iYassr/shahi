Pod::Spec.new do |s|
  s.name           = 'SshTunnel'
  s.version        = '1.0.0'
  s.summary        = 'SSH local port forwarding for Shahi'
  s.description    = 'Opens an SSH session and forwards a local port to the sidecar behind it.'
  s.author         = 'Shahi'
  s.homepage       = 'https://github.com/iYassr/shahi'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # libssh2 built from source with device AND simulator slices (NMSSH's
  # prebuilt binaries are device-only, so they cannot link for the Apple
  # Silicon simulator). This pod bundles its own crypto, so the whole tunnel —
  # connect, handshake, auth, direct-tcpip forward — is libssh2 in
  # SshForwarder; nothing else is needed.
  s.dependency 'libssh2-iosx', '~> 1.11.0.1'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
  # Public so the pod's umbrella header re-exports SshForwarder.h and the Swift
  # module (SshTunnelModule.swift) can call into it without a bridging header.
  s.public_header_files = "**/*.h"
end
