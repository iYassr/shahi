import ExpoModulesCore

/// JavaScript's view of dictation (mobile/src/lib/dictation.ts). iOS 26 and an
/// iPhone that runs Apple's SpeechTranscriber, or nothing: there is no other engine.
public final class ShahiDictationModule: Module {
  private var storage: AnyObject?

  @available(iOS 26.0, *)
  @MainActor private func session() -> DictationSession {
    if let value = storage as? DictationSession { return value }
    let value = DictationSession()
    value.send = { [weak self] event in self?.sendEvent("change", event) }
    storage = value
    return value
  }

  public func definition() -> ModuleDefinition {
    Name("ShahiDictation")
    Events("change")
    AsyncFunction("availability") { () async -> [String: Any] in
      guard #available(iOS 26.0, *) else { return ["available": false, "installed": false] }
      return await self.session().availability()
    }
    AsyncFunction("install") { (id: String) async throws in
      guard #available(iOS 26.0, *) else { throw DictationException(nil) }
      do { try await self.session().install(id) } catch { throw DictationException(error) }
    }
    AsyncFunction("start") { (id: String) async throws in
      guard #available(iOS 26.0, *) else { throw DictationException(nil) }
      do { try await self.session().start(id) } catch { throw DictationException(error) }
    }
    AsyncFunction("finish") { (id: String) async throws -> String in
      guard #available(iOS 26.0, *) else { throw DictationException(nil) }
      do { return try await self.session().finish(id) } catch { throw DictationException(error) }
    }
    AsyncFunction("cancel") { (id: String) async in
      if #available(iOS 26.0, *) { await self.session().cancel(id) }
    }
    OnDestroy {
      Task { @MainActor in
        if #available(iOS 26.0, *), let value = self.storage as? DictationSession { value.close() }
      }
    }
  }
}

// Expo builds the JavaScript message from `reason`, not LocalizedError:
// without this override every failure read "undefined reason" (CLAUDE.md).
private final class DictationException: Exception, @unchecked Sendable {
  private let message: String
  init(_ error: Error?) {
    message = (error as? DictationFailure)?.message ?? (error == nil ? "Dictation needs iOS 26 or later." : "Dictation stopped unexpectedly. Please try again.")
    super.init()
  }
  override var reason: String { message }
}
