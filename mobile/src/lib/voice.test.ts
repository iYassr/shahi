import { appendDictation } from "./voice";

test.each([
  ["", "Fix the typo.", "Fix the typo."],
  ["Keep this draft", "  Fix the typo.  ", "Keep this draft\nFix the typo."],
  ["    existing code\n", "أصلح الخطأ", "    existing code\nأصلح الخطأ"],
  ["Preserve trailing space ", "and add this", "Preserve trailing space and add this"],
  ["Keep it exactly\n  ", "  \n  ", "Keep it exactly\n  "],
])("dictation appends without altering the existing draft: %j", (draft, transcript, expected) => {
  expect(appendDictation(draft, transcript)).toBe(expected);
});
