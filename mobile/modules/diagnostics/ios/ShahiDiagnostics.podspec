Pod::Spec.new do |s|
  s.name = 'ShahiDiagnostics'
  s.version = '1.0.0'
  s.summary = 'Shahi diagnostic reporting preferences'
  s.description = s.summary
  s.author = 'Shahi'
  s.homepage = 'https://github.com/iYassr/shahi'
  s.platforms = { :ios => '16.4' }
  s.source = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
end
