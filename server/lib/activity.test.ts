import { describe, expect, test } from "bun:test";
import { parseActivity } from "./activity";

describe("parseActivity", () => {
  // Every one of these was captured from a live agent.
  test.each([
    ["✽ Smooshing… (7m 54s · ↓ 23.7k tokens)", "Smooshing…", "7m 54s", "↓ 23.7k tokens"],
    ["· Smooshing… (7m 59s · ↓ 24.1k tokens)", "Smooshing…", "7m 59s", "↓ 24.1k tokens"],
    ["✻ Smooshing… (8m 2s · ↓ 24.1k tokens)", "Smooshing…", "8m 2s", "↓ 24.1k tokens"],
    ["* Smooshing… (8m 7s · ↓ 24.1k tokens)", "Smooshing…", "8m 7s", "↓ 24.1k tokens"],
    ["✢ Seasoning… (14m 40s · ↓ 56.6k tokens)", "Seasoning…", "14m 40s", "↓ 56.6k tokens"],
    [
      "· Burrowing… (16s · still thinking with high effort)",
      "Burrowing…",
      "16s",
      "still thinking with high effort",
    ],
  ])("parses %s", (line, verb, elapsed, detail) => {
    expect(parseActivity(line)).toEqual({ verb, elapsed, detail });
  });

  test("finds it inside a full screen, indented", () => {
    const screen = [
      "  ⏺ Reading the file…",
      "",
      "     ✻ Pondering… (2m 1s · ↓ 9.0k tokens)",
      "  ────────────────────",
      "  ❯",
    ].join("\n");
    expect(parseActivity(screen)?.verb).toBe("Pondering…");
  });

  // A running tool looks superficially identical but carries no spinner glyph.
  // Anchoring on the trailing parenthesis would have caught this by mistake and
  // reported the agent's own command as its status.
  test("ignores a running tool line", () => {
    expect(parseActivity("import { Herd… (5s · 6 lines)")).toBeNull();
  });

  test("ignores a numbered list entry that ends in parentheses", () => {
    expect(parseActivity("  2. Generator (mappings/generate_xlsx.py)")).toBeNull();
  });

  test("returns null for an idle screen", () => {
    expect(parseActivity(["  ⏺ Done.", "", "  ❯", "  user@host:~/x (main)"].join("\n"))).toBeNull();
  });

  // A partially repainted screen can still show an older line above the current
  // one; the live one is the lower.
  test("takes the lowest status line on the screen", () => {
    const screen = ["✻ Pondering… (1m 0s · ↓ 1k tokens)", "…", "✽ Smooshing… (2m 0s · ↓ 2k tokens)"].join("\n");
    expect(parseActivity(screen)?.elapsed).toBe("2m 0s");
  });

  test("copes with no detail after the elapsed time", () => {
    expect(parseActivity("✻ Thinking… (4s)")).toEqual({
      verb: "Thinking…",
      elapsed: "4s",
      detail: null,
    });
  });

  test("keeps a detail that itself contains a separator", () => {
    expect(parseActivity("✻ Working… (1s · a · b)")?.detail).toBe("a · b");
  });
});
