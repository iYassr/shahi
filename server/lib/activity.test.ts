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

describe("codex", () => {
  // Captured from a live codex pane. Different leading glyph, no ellipsis on the
  // verb, and `•` rather than `·` as the separator.
  test("parses codex's working line", () => {
    expect(parseActivity("• Working (5s • esc to interrupt)")).toEqual({
      verb: "Working",
      elapsed: "5s",
      detail: "esc to interrupt",
    });
  });

  test("finds it under codex's conversation", () => {
    const screen = [
      "› test",
      "• Test received successfully.",
      "› write a haiku about terminals",
      "• Working (12s • esc to interrupt)",
      "  gpt-5.6-sol default · ~/Shahi",
    ].join("\n");
    expect(parseActivity(screen)?.elapsed).toBe("12s");
  });

  // The discriminator. An ordinary codex reply that happens to end in brackets
  // must not parse as a status line and show a timer that never moves — the
  // parenthetical has to open with an elapsed time.
  test("ignores a reply that merely ends in parentheses", () => {
    expect(parseActivity("• Done (finally)")).toBeNull();
    expect(parseActivity("• Fixed it (see the diff above)")).toBeNull();
  });

  test("ignores codex conversation lines", () => {
    expect(parseActivity("• I'm doing well—curious and ready to help. How are you?")).toBeNull();
    expect(parseActivity("› write a haiku about terminals")).toBeNull();
  });
});
