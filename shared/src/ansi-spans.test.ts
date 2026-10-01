import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stripAnsi } from "../../server/lib/prompt-parser";
import { ansiLines, colour256, spanColours } from "./ansi-spans";

const ESC = "\x1b";
const text = (screen: string) => ansiLines(screen).map((line) => line.map((span) => span.text).join("")).join("\n");

// Every screen herdr handed the parsers in the fixtures: the characters drawn
// in colour must be exactly the frame's `text`, or a copied line, a width
// measured from `text`, or a tap on a row would disagree with what is shown.
test("the characters are exactly stripAnsi's, for every captured screen", () => {
  const fixtures = join(import.meta.dir, "..", "..", "server", "fixtures");
  const files = [
    ...readdirSync(fixtures).filter((f) => f.endsWith("__ansi.txt")).map((f) => join(fixtures, f)),
    ...readdirSync(join(fixtures, "startup")).filter((f) => f.endsWith(".ansi")).map((f) => join(fixtures, "startup", f)),
  ];
  expect(files.length).toBeGreaterThan(20);
  for (const file of files) {
    const screen = readFileSync(file, "utf8");
    expect(text(screen)).toBe(stripAnsi(screen));
  }
});

test("other escapes are dropped as stripAnsi drops them", () => {
  const screen = `${ESC}]0;title${ESC}\\a${ESC}[2Jb${ESC}Mc${ESC}[?25ld`;
  expect(text(screen)).toBe(stripAnsi(screen));
  expect(text(screen)).toBe("abcd");
});

test("24-bit, 256-colour and standard colours, and resets", () => {
  const [line] = ansiLines(`${ESC}[38;2;215;119;87mclaude${ESC}[0m ${ESC}[38;5;76mok${ESC}[39m ${ESC}[41mred${ESC}[49m ${ESC}[94mblue`);
  expect(line).toEqual([
    { text: "claude", fg: "#D77757" },
    { text: " " },
    { text: "ok", fg: "#5FD700" },
    { text: " " },
    { text: "red", bg: "#E06C75" },
    { text: " " },
    { text: "blue", fg: "#82C4FF" },
  ]);
});

test("weights, italics, underline and inverse, turned on and off on their own", () => {
  const [line] = ansiLines(`${ESC}[1mbold${ESC}[22m ${ESC}[2mdim${ESC}[22m ${ESC}[3mit${ESC}[23m ${ESC}[4mu${ESC}[24m ${ESC}[7minv${ESC}[27m.`);
  expect(line).toEqual([
    { text: "bold", bold: true },
    { text: " " },
    { text: "dim", dim: true },
    { text: " " },
    { text: "it", italic: true },
    { text: " " },
    { text: "u", underline: true },
    { text: " " },
    { text: "inv", inverse: true },
    { text: "." },
  ]);
});

test("a style left open at the end of a row carries into the next", () => {
  const lines = ansiLines(`${ESC}[32mgreen\nstill green${ESC}[0m\nplain`);
  expect(lines[0]).toEqual([{ text: "green", fg: "#98C379" }]);
  expect(lines[1]).toEqual([{ text: "still green", fg: "#98C379" }]);
  expect(lines[2]).toEqual([{ text: "plain" }]);
});

// The Screen redraws on every frame while watched; a row that did not change
// must come back as the same array so a memoised row skips its redraw.
test("an unchanged row comes back as the same object on the next read", () => {
  const first = ansiLines(`${ESC}[1mheader${ESC}[0m\nworking 1s`);
  const second = ansiLines(`${ESC}[1mheader${ESC}[0m\nworking 2s`);
  expect(second[0]).toBe(first[0]);
  expect(second[1]).not.toBe(first[1]);
});

test("the 256-colour table: standard, cube and greys", () => {
  expect(colour256(1)).toBe("#E06C75");
  expect(colour256(16)).toBe("#000000");
  expect(colour256(196)).toBe("#FF0000");
  expect(colour256(232)).toBe("#080808");
  expect(colour256(255)).toBe("#EEEEEE");
  expect(colour256(256)).toBeUndefined();
});

test("inverse swaps the colours, with the client's defaults where a span has none", () => {
  const defaults = { fg: "#F0EFEA", bg: "#0E0D0B" };
  expect(spanColours({ text: "x", inverse: true }, defaults)).toEqual({ color: "#0E0D0B", backgroundColor: "#F0EFEA" });
  expect(spanColours({ text: "x", fg: "#FF0000", inverse: true }, defaults)).toEqual({ color: "#0E0D0B", backgroundColor: "#FF0000" });
  expect(spanColours({ text: "x", fg: "#FF0000" }, defaults)).toEqual({ color: "#FF0000" });
});
