import { expect, test } from "bun:test";
import { screenTail } from "./screen-card";

test("a screen drawn at the top keeps its rows and loses the empty terminal below", () => {
  const screen = ["", "  Update available · 0.157.1 → 0.158.0", "", "› 1. Update now", "  2. Skip", ...Array(30).fill("   ")].join("\n");
  expect(screenTail(screen)).toEqual(["  Update available · 0.157.1 → 0.158.0", "", "› 1. Update now", "  2. Skip"]);
});

test("a screen drawn at the bottom keeps its last rows, as the terminal has them", () => {
  const screen = Array.from({ length: 40 }, (_, i) => `row ${i}   `).join("\n");
  const tail = screenTail(screen, 5);
  expect(tail).toEqual(["row 35", "row 36", "row 37", "row 38", "row 39"]);
});

test("an empty screen has nothing to show", () => {
  expect(screenTail("\n\n   \n")).toEqual([]);
});
