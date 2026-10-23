Pod::Spec.new do |s|
  s.name = 'CindyMobileHarness'
  s.version = '0.1.0'
  s.summary = 'Cindy durable mobile agent kernel'
  s.license = { :type => 'Apache-2.0' }
  s.author = 'Cindy'
  s.homepage = 'https://github.com/makecindy/cindy'
  s.source = { :git => 'https://github.com/makecindy/cindy.git' }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.0'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.{swift,h}'
  s.public_header_files = 'CindyMobileHarness.h'
  s.vendored_libraries = 'lib/libcindy_mobile_harness.a'
  s.frameworks = 'Security'
  s.weak_frameworks = 'FoundationModels'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.script_phase = {
    :name => 'Build Cindy Rust kernel',
    :script => 'bash "${PODS_TARGET_SRCROOT}/../build-ios.sh"',
    :execution_position => :before_compile,
    :always_out_of_date => '1'
  }
end
