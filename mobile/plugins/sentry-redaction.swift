// A crash's message with what could be someone's own words taken out: the
// rules of `redactErrorMessage` in shared/src/diagnostics.ts, in Swift because
// a native crash is sent at the next launch before any JavaScript runs. Both
// are checked against shared/src/error-redaction-vectors.json
// (mobile/plugins/tests/run.sh); change them together.
import Foundation

enum ShahiRedaction {
  private static let code = try! NSRegularExpression(pattern: #"^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*|\[\d+\])*(?:\(\))?$"#)
  private static let engineQuote = try! NSRegularExpression(pattern: #"(?:evaluating|property) ?$"#, options: [.caseInsensitive])
  private static let identifier = try! NSRegularExpression(pattern: #"^[A-Za-z_][A-Za-z0-9_.:]{0,79}$"#)

  /// An exception type is a name; anything else is not trusted to be one.
  static func type(_ value: String?) -> String? {
    guard let value, matches(identifier, value) else { return nil }
    return value
  }

  static func message(_ value: String?) -> String {
    guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return "Application error" }
    var text = replace(value, #"\s+"#) { _, _ in " " }.trimmingCharacters(in: .whitespaces)
    text = replace(text, #"\b[a-z][a-z0-9+.-]*://[^\s"'`<>]+"#, options: [.caseInsensitive]) { _, _ in "<url>" }
    text = replace(text, #"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"#) { _, _ in "<email>" }
    text = replace(text, #"(^|[\s(:=\[,])(["'`“‘])([^"'`“”‘’]{0,200}?)(["'`”’])(?=$|[\s).,:;\]])"#) { match, whole in
      let before = whole.substring(with: match.range(at: 1))
      let inner = whole.substring(with: match.range(at: 3))
      let start = max(0, match.range.location - 16)
      let prefix = whole.substring(with: NSRange(location: start, length: match.range.location - start + match.range(at: 1).length))
      let keep = matches(engineQuote, prefix) && matches(code, inner)
      return before + (keep ? whole.substring(with: match.range(at: 2)) + inner + whole.substring(with: match.range(at: 4)) : "<text>")
    }
    text = replace(text, #"(?:~|\.{1,2})?/[^\s"'`<>]*/[^\s"'`<>]*"#) { _, _ in "<path>" }
    // Secrets and identifiers mix letters and digits; a long code name does not.
    text = replace(text, #"[A-Za-z0-9+/_-]{24,}={0,2}"#) { match, whole in
      let word = whole.substring(with: match.range)
      return word.rangeOfCharacter(from: .decimalDigits) != nil && word.rangeOfCharacter(from: .letters) != nil ? "<id>" : word
    }
    // Whole numbers only: a memory address such as 0x0000000102a3b4c8 is not one.
    text = replace(text, #"\b\d{7,}\b"#) { _, _ in "<number>" }
    return String(text.unicodeScalars.prefix(300).map(Character.init))
  }

  private static func matches(_ regex: NSRegularExpression, _ text: String) -> Bool {
    regex.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length)) != nil
  }

  private static func replace(_ text: String, _ pattern: String, options: NSRegularExpression.Options = [], _ with: (NSTextCheckingResult, NSString) -> String) -> String {
    guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else { return text }
    let whole = text as NSString
    let result = NSMutableString(string: text)
    for match in regex.matches(in: text, range: NSRange(location: 0, length: whole.length)).reversed() {
      result.replaceCharacters(in: match.range, with: with(match, whole))
    }
    return result as String
  }
}
