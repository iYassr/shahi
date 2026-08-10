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
  # NMSSH vendors libssh2 + OpenSSL and is App Store proven. It handles the
  # session and both auth modes; the direct-tcpip forward is driven through the
  # libssh2 session it exposes. See SshTunnelModule.swift.
  s.dependency 'NMSSH'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
  # Public so the pod's umbrella header re-exports SshForwarder.h and the Swift
  # module (SshTunnelModule.swift) can call into it without a bridging header.
  s.public_header_files = "**/*.h"
end
