// Checks ShahiRedaction against the vectors the TypeScript rules use.
import Foundation

let url = URL(fileURLWithPath: CommandLine.arguments[1])
let vectors = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [[String]]
var failures = 0
for pair in vectors where ShahiRedaction.message(pair[0]) != pair[1] {
  failures += 1
  print("FAIL\n  in:   \(pair[0])\n  want: \(pair[1])\n  got:  \(ShahiRedaction.message(pair[0]))")
}
if ShahiRedaction.message(String(repeating: "x", count: 1000)).unicodeScalars.count != 300 { failures += 1; print("FAIL length cap") }
if ShahiRedaction.type("RCTFatalException") != "RCTFatalException" || ShahiRedaction.type("not a <type>") != nil { failures += 1; print("FAIL type rule") }
print(failures == 0 ? "ok: \(vectors.count) vectors" : "\(failures) failed")
exit(failures == 0 ? 0 : 1)
