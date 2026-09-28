import ExpoModulesCore

public final class ShahiVoiceModule: Module {
  private var storage: AnyObject?

  @available(iOS 26.0, *)
  @MainActor private func voice() -> VoiceSession {
    if let value = storage as? VoiceSession { return value }
    let value = VoiceSession()
    value.changed = { [weak self] event in self?.sendEvent("change", event) }
    storage = value
    return value
  }

  public func definition() -> ModuleDefinition {
    Name("ShahiVoice")
    Events("change")
    AsyncFunction("support") { () async -> [String: Any] in
      guard #available(iOS 26.0, *) else { return ["available": false, "locales": [], "preferred": "", "maximumSeconds": 300] }
      return await self.voice().support()
    }
    AsyncFunction("prepare") { (id: String, locale: String, download: Bool) async throws -> Bool in
      guard #available(iOS 26.0, *) else { throw VoiceException(VoiceFailure(message: "Voice input requires iOS 26 or later.")) }
      do { return try await self.voice().prepare(id, localeID: locale, allowDownload: download) }
      catch { throw VoiceException(error) }
    }
    AsyncFunction("progress") { (id: String) async -> Double in
      guard #available(iOS 26.0, *) else { return 0 }
      return await self.voice().progress(id)
    }
    AsyncFunction("start") { (id: String) async throws in
      guard #available(iOS 26.0, *) else { throw VoiceException(VoiceFailure(message: "Voice input requires iOS 26 or later.")) }
      do { try await self.voice().start(id) }
      catch { throw VoiceException(error) }
    }
    AsyncFunction("stop") { (id: String) async throws -> String in
      guard #available(iOS 26.0, *) else { throw VoiceException(VoiceFailure(message: "Voice input requires iOS 26 or later.")) }
      do { return try await self.voice().stop(id) }
      catch { throw VoiceException(error) }
    }
    AsyncFunction("cancel") { (id: String) async in
      if #available(iOS 26.0, *) { await self.voice().cancel(id) }
    }
    OnDestroy {
      Task { @MainActor in
        if #available(iOS 26.0, *), let value = self.storage as? VoiceSession { value.close() }
      }
    }
  }
}

// Expo builds the JS message from Exception.reason, not LocalizedError.
private final class VoiceException: Exception, @unchecked Sendable {
  private let message: String
  init(_ error: Error) {
    message = (error as? VoiceFailure)?.message ?? "Voice input was cancelled."
    super.init()
  }
  override var reason: String { message }
}
