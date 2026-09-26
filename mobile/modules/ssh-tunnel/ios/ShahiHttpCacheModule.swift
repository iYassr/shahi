import ExpoModulesCore

/**
 * Keeps every HTTP answer this app receives off the disk.
 *
 * All of them come from the person's own computer, most through an SSH
 * forward, and they carry what grants control of it and what is on its
 * terminals: the sign-in with the Shahi passcode in its body and the session
 * cookie in its answer, sessions, frames, transcripts and images. Expo's
 * fetch drops the app's `cache: "no-store"` (its native request has no cache
 * field) and runs on URLSessionConfiguration.default, whose cache is
 * URLCache.shared, so all of it went into Library/Caches/<bundle>/Cache.db,
 * where it outlived sign-out with the passcode and live cookies inside
 * (pre-release bug hunt). Nothing in the app wants an HTTP cache: images are
 * decoded from API answers, and the transcript's ETag is kept by the app.
 *
 * The shared cache itself is emptied and given no room, so every session on
 * the default configuration stores nothing, whenever it was made. Modules are
 * created before JavaScript runs, so this precedes the first request.
 * Measured on macOS's Foundation, which iOS shares: emptying first and then
 * setting the capacities removes what an earlier build wrote; the other order
 * detaches the file and leaves every row in it.
 */
public class ShahiHttpCacheModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ShahiHttpCache")

    OnCreate {
      let cache = URLCache.shared
      cache.removeAllCachedResponses()
      cache.memoryCapacity = 0
      cache.diskCapacity = 0
    }
  }
}
