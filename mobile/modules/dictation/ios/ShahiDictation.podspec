Pod::Spec.new do |s|
  s.name           = 'ShahiDictation'
  s.version        = '1.0.0'
  s.summary        = 'Live on-device dictation for Shahi'
  s.description    = "Streams the microphone into Apple's SpeechTranscriber (iOS 26) and reports text as it settles."
  s.author         = 'Shahi'
  s.homepage       = 'https://github.com/iYassr/shahi'
  # The app's own minimum; every entry point checks for iOS 26 at run time.
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'Speech', 'AVFoundation'
  s.source_files   = '*.swift'
end
