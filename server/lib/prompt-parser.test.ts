/**
 * Parser tests, driven by real screens captured from a live herdr session.
 * See fixtures/README.md.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parsePrompt, stripAnsi } from "./prompt-parser";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const readFixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

describe("real captured screens", () => {
  test("parses the plan-approval prompt from the blocked pane", () => {
    const parsed = parsePrompt(readFixture("blocked__w4-p2__text.txt"));

    expect(parsed).not.toBeNull();
    expect(parsed!.question).toBe(
      "Claude has written up a plan and is ready to execute. Would you like to proceed?",
    );
    expect(parsed!.options).toEqual([
      { index: 1, label: "Yes, and bypass permissions", selected: true },
      { index: 2, label: "Yes, manually approve edits", selected: false },
      { index: 3, label: "No, refine with Ultraplan on Claude Code on the web", selected: false },
      {
        index: 4,
        label: "Tell Claude what to change",
        selected: false,
        // Belongs to option 4, not to the prompt: it says what pressing 4 then
        // does. It used to arrive as a free-floating hint under the whole list.
        detail: "shift+tab to approve with this feedback",
      },
    ]);
  });

  test("parses the question tool's list, explanations and all", () => {
    const parsed = parsePrompt(readFixture("blocked__wK-p2__text.txt"));

    expect(parsed).not.toBeNull();
    expect(parsed!.question).toBe("Which colour do you prefer?");
    expect(parsed!.options).toEqual([
      {
        index: 1,
        label: "Red",
        selected: true,
        detail: "Warm, high-contrast — reads as alert or emphasis.",
      },
      {
        index: 2,
        label: "Green",
        selected: false,
        detail: "Cool-warm midpoint — reads as success or growth.",
      },
      {
        index: 3,
        label: "Blue",
        selected: false,
        detail: "Cool, calm — reads as informational or neutral.",
      },
      { index: 4, label: "Type something.", selected: false },
      // Below a separator rule, which used to end the run and lose the option.
      { index: 5, label: "Chat about this", selected: false },
    ]);
  });

  test("the question tool's list parses the same from raw ANSI", () => {
    expect(parsePrompt(readFixture("blocked__wK-p2__ansi.txt"))).toEqual(
      parsePrompt(readFixture("blocked__wK-p2__text.txt")),
    );
  });

  test("reads a codex approval: the question, the command, and the answers", () => {
    const parsed = parsePrompt(readFixture("blocked__wE-p6__text.txt"));

    expect(parsed).not.toBeNull();
    // Not the command, which is what taking the nearest paragraph gave: eight
    // wrapped lines of shell as a heading, with the answers pushed off screen.
    expect(parsed!.question).toBe("Would you like to run the following command?");

    // `Reason:` ends in a question mark here and is still not the question.
    expect(parsed!.context).toEqual([
      "Environment: local",
      expect.stringContaining("Reason: May I inspect"),
      expect.stringContaining("$ sed -n"),
    ]);

    expect(parsed!.options.map((o) => o.index)).toEqual([1, 2, 3]);
    expect(parsed!.options[0]).toMatchObject({ label: "Yes, proceed (y)", selected: true });
  });

  test("produces identical results from the raw-ANSI capture", () => {
    expect(parsePrompt(readFixture("blocked__w4-p2__ansi.txt"))).toEqual(
      parsePrompt(readFixture("blocked__w4-p2__text.txt")),
    );
  });

  // The costly failure is a false positive: showing answer buttons on an agent
  // that is not actually waiting, and sending a stray keystroke into a live
  // session. Every non-blocked capture must come back null.
  const nonBlocked = readdirSync(FIXTURES).filter(
    (f) => f.endsWith(".txt") && !f.startsWith("blocked__"),
  );

  test.each(nonBlocked)("returns null for %s", (name) => {
    expect(parsePrompt(readFixture(name))).toBeNull();
  });

  test("every agent status is represented among the captured screens", () => {
    const statuses = new Set(
      readdirSync(FIXTURES)
        .filter((f) => f.endsWith("__text.txt"))
        .map((f) => f.split("__")[0]),
    );
    expect(statuses).toEqual(new Set(["blocked", "working", "idle", "done"]));
  });
});

describe("synthetic shapes", () => {
  const permissionPrompt = [
    "  ⏺ Update(src/index.ts)",
    "  ────────────────────────────────",
    "  Do you want to make this edit to index.ts?",
    "",
    "  ❯ 1. Yes",
    "    2. Yes, and don't ask again this session",
    "    3. No, and tell Claude what to do differently",
    "",
  ].join("\n");

  test("parses a permission prompt", () => {
    const parsed = parsePrompt(permissionPrompt);
    expect(parsed?.question).toBe("Do you want to make this edit to index.ts?");
    expect(parsed?.options.map((o) => o.index)).toEqual([1, 2, 3]);
    expect(parsed?.options.find((o) => o.selected)?.index).toBe(1);
  });

  test("tracks a selection other than the first", () => {
    const moved = permissionPrompt.replace("  ❯ 1. Yes", "    1. Yes").replace("    2. Yes, and", "  ❯ 2. Yes, and");
    expect(parsePrompt(moved)?.options.find((o) => o.selected)?.index).toBe(2);
  });

  test("rejoins a question wrapped across lines", () => {
    const wrapped = [
      "  Claude wants to run a command that will modify files outside the",
      "  current working directory. Do you want to allow this?",
      "",
      "  ❯ 1. Yes",
      "    2. No",
    ].join("\n");
    expect(parsePrompt(wrapped)?.question).toBe(
      "Claude wants to run a command that will modify files outside the " +
        "current working directory. Do you want to allow this?",
    );
  });

  // Regression, found by sweeping the parser across every live pane rather than
  // just the fixtures: an idle agent had written a numbered list in its answer
  // and the parser offered it as a set of answer buttons. An unmarked list is
  // prose, whatever else it looks like.
  test("ignores numbered prose in an agent's answer", () => {
    const prose = [
      "  ⏺ What you need to do on the page:",
      "",
      "  1. Enter your phone number and document number",
      "  2. Review and tick the distance sales contract checkbox",
      "  3. Enter your card details and pay",
      "",
      "  Anything else you want me to check before you pay?",
      "",
      "  ────────────────────────────────",
      "  ❯",
      "  ────────────────────────────────",
      "  operator@ubuntu:~/travelplanner (main)",
    ].join("\n");
    expect(parsePrompt(prose)).toBeNull();
  });

  test("ignores a numbered list sitting directly under a question", () => {
    // The nastiest shape: prose that has every structural feature of a prompt
    // except the selection cursor.
    const looksLikeAPrompt = [
      "  Which of these should I do first?",
      "",
      "  1. Refactor the parser",
      "  2. Add the push notifications",
      "  3. Wire up the dashboard",
    ].join("\n");
    expect(parsePrompt(looksLikeAPrompt)).toBeNull();
  });

  test("rejects a list with more than one cursor", () => {
    const twoCursors = ["  Pick one?", "", "  ❯ 1. Alpha", "  ❯ 2. Beta"].join("\n");
    expect(parsePrompt(twoCursors)).toBeNull();
  });

  test("rejects a list that does not start at 1", () => {
    const partial = ["  Pick one?", "", "  ❯ 2. Second", "    3. Third"].join("\n");
    expect(parsePrompt(partial)).toBeNull();
  });

  test("rejects a single-option list", () => {
    expect(parsePrompt(["  Continue?", "", "  ❯ 1. Yes"].join("\n"))).toBeNull();
  });

  test("requires a question above the options", () => {
    expect(parsePrompt(["  ❯ 1. Yes", "    2. No"].join("\n"))).toBeNull();
  });

  test("takes the last prompt when an earlier one is still on screen", () => {
    const two = [
      "  Older question?",
      "",
      "  ❯ 1. Alpha",
      "    2. Beta",
      "",
      "  ⏺ Thanks.",
      "  ────────────────────",
      "  Newer question?",
      "",
      "    1. Gamma",
      "  ❯ 2. Delta",
    ].join("\n");
    const parsed = parsePrompt(two);
    expect(parsed?.question).toBe("Newer question?");
    expect(parsed?.options.map((o) => o.label)).toEqual(["Gamma", "Delta"]);
  });
});

describe("stripAnsi", () => {
  const ESC = "\x1b";
  const BEL = "\x07";

  test("removes SGR colour sequences", () => {
    expect(stripAnsi(`${ESC}[38;2;153;153;153mhello${ESC}[0m world`)).toBe("hello world");
  });

  test("removes cursor and erase sequences", () => {
    expect(stripAnsi(`${ESC}[2J${ESC}[H${ESC}[1;31mred${ESC}[0m`)).toBe("red");
  });

  // Regression: the OSC branch originally had an empty alternation, so it
  // stopped at `]` and leaked the whole window-title payload into the text --
  // which would have surfaced as garbage inside parsed questions.
  test("removes an OSC window-title sequence entirely, BEL-terminated", () => {
    expect(stripAnsi(`${ESC}]0;window title${BEL}after`)).toBe("after");
  });

  test("removes an OSC sequence terminated by ST", () => {
    expect(stripAnsi(`${ESC}]0;title${ESC}\\after`)).toBe("after");
  });

  test("handles the single-byte CSI form", () => {
    expect(stripAnsi("\x9b31mred\x9b0m")).toBe("red");
  });

  test("leaves text that merely looks like escapes untouched", () => {
    expect(stripAnsi("brackets [not ansi] stay, 100% done")).toBe(
      "brackets [not ansi] stay, 100% done",
    );
  });

  test("strips every escape from a real capture", () => {
    const ansi = readFixture("blocked__w4-p2__ansi.txt");
    expect(ansi).toContain(ESC);
    expect(stripAnsi(ansi)).not.toContain(ESC);
  });

  test("a real capture strips to exactly its text-format twin", () => {
    // herdr's own strip_ansi:true output is the reference implementation.
    const normalise = (s: string) =>
      s
        .split("\n")
        .map((l) => l.trimEnd())
        .join("\n")
        .trim();
    expect(normalise(stripAnsi(readFixture("blocked__w4-p2__ansi.txt")))).toBe(
      normalise(readFixture("blocked__w4-p2__text.txt")),
    );
  });
});

describe("other agents", () => {
  // codex draws its selection cursor as `›` (U+203A) rather than Claude Code's
  // `❯` (U+276F). Captured from a real codex startup prompt.
  test("parses a codex prompt", () => {
    const codexTrust = [
      "> You are in /tmp",
      "  Do you trust the contents of this directory?",
      "",
      "› 1. Yes, continue",
      "  2. No, quit",
    ].join("\n");

    const parsed = parsePrompt(codexTrust);
    expect(parsed?.question).toBe("Do you trust the contents of this directory?");
    expect(parsed?.options).toEqual([
      { index: 1, label: "Yes, continue", selected: true },
      { index: 2, label: "No, quit", selected: false },
    ]);
  });
});
