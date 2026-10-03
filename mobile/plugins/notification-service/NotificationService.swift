import Foundation
import Security
import UserNotifications

/// Opens a sealed Shahi notification before iOS shows it.
///
/// The computer sends a waiting agent's question sealed (see
/// `PushEnvelope.swift`), with content-free words outside the box for Expo
/// and Apple to carry. Here, on the phone, the box is opened with the key the
/// app stored for this extension, the question replaces those words, and the
/// prompt's answers become the notification's actions. When the box cannot
/// be opened, the content-free words are what shows, and there are no
/// actions: a tap opens the pane, as every notification did before.
final class NotificationService: UNNotificationServiceExtension {
  private let lock = NSLock()
  private var deliver: ((UNNotificationContent) -> Void)?
  private var fallback: UNNotificationContent?

  override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
    let plain = Self.contentFree(request.content)
    lock.lock(); deliver = contentHandler; fallback = plain; lock.unlock()

    guard let data = request.content.userInfo["body"] as? [String: Any],
          data["v"] as? Int == PushEnvelope.version,
          let kid = data["kid"] as? String,
          let box = data["sealed"] as? String,
          let serverId = data["serverId"] as? String,
          let paneId = data["paneId"] as? String,
          let key = PushKeys.key(id: kid),
          let opened = PushEnvelope.open(box: box, key: key, serverId: serverId, paneId: paneId),
          let content = plain.mutableCopy() as? UNMutableNotificationContent
    else { return finish(plain) }

    content.title = opened.title
    content.subtitle = opened.subtitle ?? ""
    content.body = opened.body
    // The app reads `body` as the notification's data: the opened answer
    // goes there for an action to post, and the box itself is dropped.
    var opens = data
    opens.removeValue(forKey: "sealed")
    if let instanceId = opened.instanceId { opens["instanceId"] = instanceId }
    if let answer = opened.answer,
       let encoded = try? JSONEncoder().encode(answer),
       let object = try? JSONSerialization.jsonObject(with: encoded) {
      opens["answer"] = object
    }
    var userInfo = content.userInfo
    userInfo["body"] = opens
    content.userInfo = userInfo

    guard let options = opened.answer?.options, !options.isEmpty else { return finish(content) }
    // Held strongly until it delivers: a weak capture let an extension object
    // released early drop its notification, never handing it to iOS
    // (simulator harness, October 2026). Only the notification center holds
    // the closure, until it runs, so this makes no cycle.
    AnswerCategories.register(options) { identifier in
      content.categoryIdentifier = identifier
      self.finish(content)
    }
  }

  /// Out of time: the content-free words, never a half-built notification.
  override func serviceExtensionTimeWillExpire() {
    lock.lock(); let plain = fallback; lock.unlock()
    if let plain { finish(plain) }
  }

  private func finish(_ content: UNNotificationContent) {
    lock.lock(); let handler = deliver; deliver = nil; lock.unlock()
    handler?(content)
  }

  /// The notification as it arrived, minus anything only this extension may
  /// add: a category (which brings answer buttons) and an opened answer. The
  /// push services write everything outside the box, so a notification that
  /// arrived with either was not sealed by the computer and must not offer a
  /// button that answers for the person.
  static func contentFree(_ content: UNNotificationContent) -> UNNotificationContent {
    guard let copy = content.mutableCopy() as? UNMutableNotificationContent else { return content }
    copy.categoryIdentifier = ""
    if var data = copy.userInfo["body"] as? [String: Any] {
      data.removeValue(forKey: "answer")
      var userInfo = copy.userInfo
      userInfo["body"] = data
      copy.userInfo = userInfo
    }
    return copy
  }
}

/// The keys the app stored for this extension, one per computer that sends
/// sealed notifications, named by the id the notification carries.
///
/// The app writes them with expo-secure-store into a keychain access group
/// the two share; the extension is entitled to that group alone, so it cannot
/// read the app's credentials. Readable after the first unlock, because a
/// notification arrives on a locked phone.
enum PushKeys {
  static let service = "shahi.push-keys:no-auth"

  static func key(id: String) -> Data? {
    guard id.count == 16, id.allSatisfy({ $0.isHexDigit }) else { return nil }
    // expo-secure-store stores the key's name as data in both of these.
    let account = Data("shahi.push-key.\(id)".utf8)
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecReturnData as String: true,
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
          let stored = item as? Data,
          let text = String(data: stored, encoding: .utf8)
    else { return nil }
    return Data(base64Encoded: text)
  }
}

/// A notification's actions come from its category, and categories are
/// registered ahead of time, so each set of answers gets one of its own,
/// named by its titles and indexes: two notifications share a category only
/// when they offer the same buttons. A shared, fixed category re-registered
/// per notification would relabel the buttons of every notification still on
/// screen.
enum AnswerCategories {
  static let prefix = "shahi.answer."
  static let actionPrefix = "shahi.option."
  /// Distinct sets of answers kept registered. Past this they are all
  /// dropped but the new one; a notification whose set went loses its
  /// buttons and still opens its pane when tapped.
  static let limit = 32

  static func register(_ options: [SealedNotification.Option], then: @escaping (String) -> Void) {
    let identifier = prefix + digest(options)
    let center = UNUserNotificationCenter.current()
    center.getNotificationCategories { existing in
      if existing.contains(where: { $0.identifier == identifier }) { return then(identifier) }
      var categories = existing
      let ours = existing.filter { $0.identifier.hasPrefix(prefix) }
      if ours.count >= limit { categories.subtract(ours) }
      // `.foreground`: the app opens and answers with the person watching.
      // See docs/notifications.md for the measurement behind it.
      let actions = options.map {
        UNNotificationAction(identifier: actionPrefix + String($0.index), title: $0.title, options: [.authenticationRequired, .foreground])
      }
      categories.insert(UNNotificationCategory(identifier: identifier, actions: actions, intentIdentifiers: [], options: []))
      center.setNotificationCategories(categories)
      // Registration lands asynchronously; reading the set back waits for
      // it, so the notification is not shown before its buttons exist.
      center.getNotificationCategories { _ in then(identifier) }
    }
  }

  static func digest(_ options: [SealedNotification.Option]) -> String {
    // FNV-1a over the indexes and titles: stable across launches, unlike
    // Swift's seeded `Hasher`, and a name rather than a secret.
    var hash: UInt64 = 0xcbf2_9ce4_8422_2325
    for byte in options.map({ "\($0.index)\u{1f}\($0.title)" }).joined(separator: "\u{1e}").utf8 {
      hash = (hash ^ UInt64(byte)) &* 0x0000_0100_0000_01b3
    }
    return String(format: "%016llx", hash)
  }
}
