import { appendDictation, dictation } from "./dictation";

jest.mock("expo", () => ({ ...jest.requireActual("expo"), requireOptionalNativeModule: () => null }));

test("dictated text continues the draft and never replaces it", () => {
  expect(appendDictation("", "Fix the test.")).toBe("Fix the test.");
  expect(appendDictation("Please", " fix the test. ")).toBe("Please fix the test.");
  expect(appendDictation("Please ", "fix it")).toBe("Please fix it");
  // An attached path ends its own line (pane.tsx), and the words follow it.
  expect(appendDictation("~/shots/crash.png\n", "What is this?")).toBe("~/shots/crash.png\nWhat is this?");
  expect(appendDictation("Keep this", "   ")).toBe("Keep this");
});

test("a binary without the module has no dictation, rather than another engine", async () => {
  expect(await dictation.availability()).toEqual({ available: false, installed: false });
  await expect(dictation.start("x")).rejects.toThrow("Update Shahi to dictate.");
  await expect(dictation.cancel("x")).resolves.toBeUndefined();
  expect(() => dictation.listen(() => {}).remove()).not.toThrow();
});
