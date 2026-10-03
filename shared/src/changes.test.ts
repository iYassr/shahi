import { expect, test } from "bun:test";
import { changeSummary, diffRows, shownText } from "./changes";

test("a diff's rows are numbered from each hunk header, old and new apart", () => {
  const rows = diffRows([
    "@@ -10,4 +10,5 @@ function total()",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "+const c = 4;",
    " return a + b;",
    "@@ -40 +41 @@",
    "-end",
    "+end;",
    "\\ No newline at end of file",
  ]);
  expect(rows).toEqual([
    { kind: "hunk", text: "@@ -10,4 +10,5 @@ function total()" },
    { kind: "context", text: "const a = 1;", oldLine: 10, newLine: 10 },
    { kind: "removed", text: "const b = 2;", oldLine: 11 },
    { kind: "added", text: "const b = 3;", newLine: 11 },
    { kind: "added", text: "const c = 4;", newLine: 12 },
    { kind: "context", text: "return a + b;", oldLine: 12, newLine: 13 },
    { kind: "hunk", text: "@@ -40 +41 @@" },
    { kind: "removed", text: "end", oldLine: 40 },
    { kind: "added", text: "end;", newLine: 41 },
    { kind: "note", text: "No newline at end of file" },
  ]);
});

test("tabs line up at four columns and a carriage return cannot break a row in two", () => {
  expect(shownText("\tif (x)\t{")).toBe("    if (x)  {");
  expect(shownText("dos line\r")).toBe("dos line␍");
  expect(shownText("bell\x07 and delete\x7f")).toBe("bell␇ and delete␡");
  expect(shownText("plain")).toBe("plain");
});

test("a changed file is said in words, not letters and signs", () => {
  expect(changeSummary({ path: "src/a.ts", status: "modified", added: 3, removed: 1 })).toBe("src/a.ts, modified, 3 lines added, 1 removed");
  expect(changeSummary({ path: "b.ts", from: "a.ts", status: "renamed", added: 1, removed: 0 })).toBe("b.ts, renamed from a.ts, 1 line added, 0 removed");
  expect(changeSummary({ path: "logo.png", status: "untracked", added: null, removed: null })).toBe("logo.png, untracked");
});
