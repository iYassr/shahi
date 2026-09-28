Pod::Spec.new do |s|
  s.name = 'ShahiVoice'
  s.version = '1.0.0'
  s.summary = 'Private on-device dictation for Shahi'
  s.description = s.summary
  s.author = 'Shahi'
  s.homepage = 'https://github.com/iYassr/shahi'
  s.platforms = { :ios => '16.4' }
  s.source = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Speech', 'AVFoundation'
  s.source_files = '*.swift'
end
