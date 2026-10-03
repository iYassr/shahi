import CryptoKit
import Foundation

/// The sealed part of a Shahi notification, and how it is opened.
///
/// A notification travels through Expo's push service and Apple's, and both
/// can read everything outside this box. So the computer seals what an agent
/// is asking — the question, the command, the answers — with a key this phone
/// made and gave it over the already encrypted link (see
/// `server/lib/push-seal.ts`, which is the other half of this file). AES-256-GCM,
/// a fresh 96-bit nonce per message, and associated data that names the
/// format, the computer and the pane, so a box cannot be replayed under
/// another notification's routing fields: the tap would open one pane while
/// the text described another.
///
/// Anything wrong — no key, a different key, a changed byte — opens nothing,
/// and the notification shows the content-free words it arrived with.
enum PushEnvelope {
  /// Bumped with any change to the box or to what the associated data covers.
  static let version = 1

  static func associatedData(serverId: String, paneId: String) -> Data {
    Data("shahi-push/\(version)\n\(serverId)\n\(paneId)".utf8)
  }

  /// `box` is base64 of nonce ‖ ciphertext ‖ tag, as `AES.GCM.SealedBox.combined` lays it out.
  static func open(box: String, key: Data, serverId: String, paneId: String) -> SealedNotification? {
    guard key.count == 32,
          let combined = Data(base64Encoded: box),
          let sealed = try? AES.GCM.SealedBox(combined: combined),
          let plain = try? AES.GCM.open(sealed, using: SymmetricKey(data: key), authenticating: associatedData(serverId: serverId, paneId: paneId))
    else { return nil }
    return try? JSONDecoder().decode(SealedNotification.self, from: plain)
  }
}

/// What the computer sealed: the words to show, and the answers on offer.
struct SealedNotification: Decodable, Equatable {
  let title: String
  let subtitle: String?
  let body: String
  /// The occupant of the pane that asked (`DashboardPane.instanceId`).
  let instanceId: String?
  let answer: Answer?

  /// What the app posts to `/api/panes/:id/answer` for an action, exactly as
  /// the server parsed it; only `title` is cleaned for display.
  struct Answer: Codable, Equatable {
    let promptId: String
    let question: String?
    let context: [String]?
    let options: [Option]
  }

  struct Option: Codable, Equatable {
    let index: Int
    let label: String
    let title: String
  }
}
