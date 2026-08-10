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

  # Prebuilt binaries with device + simulator slices, vendored directly — no
  # from-source build at pod-install time (that path fought the toolchain six
  # different ways; see git history). libssh2 was compiled once against this
  # exact OpenSSL, so the versions match. OpenSSL is a dynamic framework and is
  # embedded + signed by CocoaPods automatically.
  s.vendored_frameworks = ['libssh2.xcframework', 'OpenSSL.xcframework']

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "*.{h,m,mm,swift}"
  # Public so the pod's umbrella re-exports SshForwarder.h and the Swift module
  # can call into it without a bridging header.
  s.public_header_files = "*.h"
end
