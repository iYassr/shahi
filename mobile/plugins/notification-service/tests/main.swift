import CryptoKit
import Foundation
import UserNotifications

/// Opens the computer's known-answer vector (`server/fixtures/push-seal-vector.json`,
/// sealed by `server/lib/push-seal.ts` and checked there too) with the
/// extension's own code, on this Mac: what the server seals, the phone opens,
/// and nothing else opens.
@main struct Harness {
  struct Vector: Decodable {
    let key: String, kid: String, nonce: String, serverId: String, paneId: String, plaintext: String, box: String
  }

  static var failures = 0
  static func check(_ ok: Bool, _ what: String) {
    print(ok ? "ok  " : "FAIL", what)
    if !ok { failures += 1 }
  }

  static func main() throws {
    let vector = try JSONDecoder().decode(Vector.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
    let key = Data(base64Encoded: vector.key)!
    let expected = try JSONDecoder().decode(SealedNotification.self, from: Data(vector.plaintext.utf8))

    let opened = PushEnvelope.open(box: vector.box, key: key, serverId: vector.serverId, paneId: vector.paneId)
    check(opened == expected, "the vector opens to the computer's plaintext")
    check(opened?.answer?.options.map(\.label) == ["Yes", "Yes, and don't ask again for python3 commands (shift+tab)", "No"], "labels arrive exactly as parsed")
    check(opened?.body.contains("ünïcødé ✓") == true, "text beyond ASCII survives")

    let kid = SHA256.hash(data: key).prefix(8).map { String(format: "%02x", $0) }.joined()
    check(kid == vector.kid, "the key id is the first 8 bytes of the key's SHA-256")

    // The nonce is the box's first 12 bytes, as the computer laid it out.
    check(Data(base64Encoded: vector.box)!.prefix(12) == Data(base64Encoded: vector.nonce)!, "the box starts with its nonce")

    check(PushEnvelope.open(box: vector.box, key: key, serverId: vector.serverId, paneId: "w1:p3") == nil, "another pane's routing does not open it")
    check(PushEnvelope.open(box: vector.box, key: key, serverId: "another-computer", paneId: vector.paneId) == nil, "another computer's routing does not open it")
    var wrong = key; wrong[0] ^= 1
    check(PushEnvelope.open(box: vector.box, key: wrong, serverId: vector.serverId, paneId: vector.paneId) == nil, "another key does not open it")
    var tampered = Data(base64Encoded: vector.box)!
    tampered[40] ^= 0x01
    check(PushEnvelope.open(box: tampered.base64EncodedString(), key: key, serverId: vector.serverId, paneId: vector.paneId) == nil, "a changed byte does not open it")
    check(PushEnvelope.open(box: "not base64!", key: key, serverId: vector.serverId, paneId: vector.paneId) == nil, "garbage does not open")
    check(PushEnvelope.open(box: vector.box, key: key.prefix(16), serverId: vector.serverId, paneId: vector.paneId) == nil, "a short key is refused")

    // What arrives outside the box is written by the push services, so the
    // extension never lets it bring buttons or an answer of its own.
    let forged = UNMutableNotificationContent()
    forged.title = "An agent needs you"
    forged.categoryIdentifier = AnswerCategories.prefix + "0000000000000000"
    forged.userInfo = ["body": ["paneId": "w1:p2", "answer": ["promptId": "x", "options": [["index": 1, "label": "Yes", "title": "Yes"]]]]]
    let plain = NotificationService.contentFree(forged)
    check(plain.categoryIdentifier.isEmpty, "an unsealed category is dropped")
    check((plain.userInfo["body"] as? [String: Any])?["answer"] == nil, "an unsealed answer is dropped")
    check((plain.userInfo["body"] as? [String: Any])?["paneId"] as? String == "w1:p2", "routing stays, so a tap still opens the pane")

    check(PushKeys.key(id: "../../etc") == nil, "a key id that is not 16 hex digits looks nothing up")

    let a = AnswerCategories.digest(expected.answer!.options)
    check(a == AnswerCategories.digest(expected.answer!.options) && a.count == 16, "a set of answers always names the same category")
    let relabelled = expected.answer!.options.map { SealedNotification.Option(index: $0.index, label: $0.label, title: $0.title + "!") }
    check(AnswerCategories.digest(relabelled) != a, "other buttons name another category")

    print(failures == 0 ? "PASS" : "FAIL \(failures)")
    exit(failures == 0 ? 0 : 1)
  }
}
