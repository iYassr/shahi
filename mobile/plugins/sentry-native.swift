
// Native crashes bypass JavaScript's beforeSend. Keep the same privacy boundary here.
private enum ShahiSentry {
  static var observer: NSObjectProtocol?
  static var started = false
  static var window = Date.distantPast
  static var reports = 0
  static let lock = NSLock()
  static var enabled: Bool { UserDefaults.standard.object(forKey: "shahi.diagnostics.enabled") as? Bool ?? true }

  static func install() {
    observer = NotificationCenter.default.addObserver(forName: Notification.Name("shahi.diagnostics.changed"), object: nil, queue: .main) { _ in configure() }
    configure()
  }
  static func configure() {
    #if !DEBUG
    guard enabled, let dsn = Bundle.main.object(forInfoDictionaryKey: "ShahiSentryDSN") as? String, !dsn.isEmpty else {
      if started { SentrySDK.close(); started = false }
      return
    }
    guard !started else { return }
    started = true
    SentrySDK.start { options in
      options.dsn = dsn
      options.releaseName = "shahi-ios@" + (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0")
      options.dist = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
      options.environment = "production"
      options.sendDefaultPii = false
      options.maxBreadcrumbs = 0
      options.maxCacheItems = 20
      options.beforeBreadcrumb = { _ in nil }
      options.enableAutoBreadcrumbTracking = false
      options.enableNetworkBreadcrumbs = false
      options.enableAutoSessionTracking = false
      options.enableAutoPerformanceTracing = false
      options.enableNetworkTracking = false
      options.enableCaptureFailedRequests = false
      options.enableSwizzling = false
      options.enableMemoryIntrospection = false
      options.enableMetricKit = false
      options.enableLogs = false
      options.enableMetrics = false
      options.sendClientReports = false
      options.attachScreenshot = false
      options.attachViewHierarchy = false
      options.beforeSend = sanitize
    }
    #endif
  }
  static func sanitize(_ event: Sentry.Event) -> Sentry.Event? {
    lock.lock(); defer { lock.unlock() }
    guard enabled, event.type == nil else { return nil }
    // React Native already submits these through the JavaScript privacy filter.
    if event.exceptions?.contains(where: { ($0.type ?? "").contains("Unhandled JS Exception") || ($0.value ?? "").contains("ExceptionsManager.reportException") }) == true { return nil }
    if Date().timeIntervalSince(window) >= 3600 { window = Date(); reports = 0 }
    guard reports < 20 else { return nil }; reports += 1
    let safe = Sentry.Event(level: event.level)
    safe.eventId = event.eventId
    safe.timestamp = event.timestamp
    safe.platform = event.platform
    safe.releaseName = event.releaseName
    safe.dist = event.dist
    safe.environment = event.environment
    safe.tags = ["client": "ios"]
    let user = Sentry.User(); user.ipAddress = "0.0.0.0"; safe.user = user
    // The type, the reason (signal, Mach exception, NSError domain and code)
    // and the message with its private parts replaced (sentry-redaction.swift).
    // All three were dropped, and a fatal crash reached Sentry as
    // "NativeError: Native application error (message omitted for privacy)"
    // with nothing to fix it from (the owner, October 2026).
    safe.exceptions = event.exceptions?.map { exception in
      let clean = Sentry.Exception(value: ShahiRedaction.message(exception.value), type: ShahiRedaction.type(exception.type) ?? "NativeError")
      clean.threadId = exception.threadId
      if let original = exception.mechanism {
        let mechanism = Sentry.Mechanism(type: ShahiRedaction.type(original.type) ?? "generic")
        mechanism.handled = original.handled
        mechanism.meta = original.meta
        clean.mechanism = mechanism
      }
      clean.stacktrace = exception.stacktrace
      cleanStack(clean.stacktrace)
      return clean
    }
    safe.threads = event.threads?.map { thread in
      thread.name = nil; cleanStack(thread.stacktrace); return thread
    }
    cleanStack(event.stacktrace); safe.stacktrace = event.stacktrace
    safe.debugMeta = event.debugMeta?.map { image in
      image.codeFile = image.codeFile.map { ($0 as NSString).lastPathComponent }; return image
    }
    if let os = event.context?["os"] as? [String: Any] {
      safe.context = ["os": os.filter { ["name", "version", "build", "kernel_version"].contains($0.key) }]
    }
    return safe
  }
  static func cleanStack(_ stack: SentryStacktrace?) {
    for frame in stack?.frames ?? [] {
      // The binary's name ("Shahi", "UIKitCore") says where a frame is; its
      // path holds the app container's per-install identifier.
      frame.package = frame.package.map { ($0 as NSString).lastPathComponent }
      frame.fileName = nil; frame.vars = nil; frame.module = nil
      frame.contextLine = nil; frame.preContext = nil; frame.postContext = nil
    }
  }
}
