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

  test("the question tool's header row comes with it, as the block above the question", () => {
    expect(parsePrompt(readFixture("blocked__wK-p2__text.txt"))!.context).toEqual(["☐ Colour"]);
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

  // Claude Code puts the command above a generic "Do you want to proceed?",
  // the reverse of codex, and the card used to show only that question: a
  // Bash approval tappable from the agents list without ever seeing the
  // command. Captured from Claude Code 2.1.280 under herdr 0.9.1.
  describe("a Claude Code permission card shows what it is asking to do", () => {
    test("a Bash card carries the command and its description", () => {
      const parsed = parsePrompt(readFixture("blocked__claude-bash__text.txt"))!;
      expect(parsed.question).toBe("Do you want to proceed?");
      expect(parsed.context).toEqual([
        'Bash command\nTip: auto mode handles these prompts for you — choose "switch to auto mode" below',
        // Separate lines, as on screen: joined with a space the description
        // read as more of the command.
        "touch probe.txt\nCreate empty probe file",
      ]);
      expect(parsed.options.map((o) => o.label)).toEqual([
        "Yes",
        "Yes, and always allow access to /private/tmp/shahi-p15.GlMGfu/proj from this project",
        "Yes, and switch to auto mode · auto mode handles these prompts for you",
        "No",
      ]);
    });

    test("a Bash card parses the same from raw ANSI", () => {
      expect(parsePrompt(readFixture("blocked__claude-bash__ansi.txt"))).toEqual(
        parsePrompt(readFixture("blocked__claude-bash__text.txt")),
      );
    });

    test("a WebFetch card carries the address", () => {
      const parsed = parsePrompt(readFixture("blocked__claude-webfetch__text.txt"))!;
      expect(parsed.question).toBe("Do you want to allow Claude to fetch this content?");
      expect(parsed.context).toEqual([
        "Fetch",
        "url: https://example.org/\nprompt: What is the page title?\nClaude wants to fetch content from example.org",
      ]);
      expect(parsePrompt(readFixture("blocked__claude-webfetch__ansi.txt"))).toEqual(parsed);
    });

    test("an MCP card carries the tool and its arguments", () => {
      const parsed = parsePrompt(readFixture("blocked__claude-mcp__text.txt"))!;
      expect(parsed.question).toBe("Do you want to proceed?");
      expect(parsed.context).toEqual([
        "Tool use",
        "probe — Echo Tool: (MCP)",
        'text: "hello"',
        "About the probe — Echo Tool:\n│ Echoes the given text back.",
      ]);
      expect(parsePrompt(readFixture("blocked__claude-mcp__ansi.txt"))).toEqual(parsed);
    });

    test("two Bash cards with the same answers differ by their command", () => {
      const touch = parsePrompt(readFixture("blocked__claude-bash__text.txt"))!;
      const rm = parsePrompt(readFixture("blocked__claude-bash-rm__text.txt"))!;
      expect(rm.options).toEqual(touch.options);
      expect(rm.context?.at(-1)).toBe("rm -rf build dist\nDelete build and dist directories");
    });

    // Variations on the captured layout, for the two ways the block could be
    // cut wrong.
    const bash = (command: string[]) =>
      readFixture("blocked__claude-bash__text.txt").replace("   touch probe.txt\n", command.map((l) => `   ${l}\n`).join(""));

    test("a command's own dashes do not end the block halfway through it", () => {
      const parsed = parsePrompt(bash(["cat > deploy.yml <<'EOF'", "---", "name: deploy", "EOF"]))!;
      expect(parsed.context?.at(-1)).toBe("cat > deploy.yml <<'EOF'\n---\nname: deploy\nEOF\nCreate empty probe file");
    });

    test("a multi-line command keeps its indentation", () => {
      const parsed = parsePrompt(bash(["python3 - <<'EOF'", "for n in range(3):", "    print(n)", "EOF"]))!;
      expect(parsed.context?.at(-1)).toBe("python3 - <<'EOF'\nfor n in range(3):\n    print(n)\nEOF\nCreate empty probe file");
    });

    test("with no rule above the question on screen, nothing is guessed", () => {
      const unbounded = ["  touch probe.txt", "  Create empty probe file", "", " Do you want to proceed?", " ❯ 1. Yes", "   2. No"].join("\n");
      expect(parsePrompt(unbounded)?.context).toBeUndefined();
    });
  });

  test("marks codex's numbered folder-trust menu as requiring Enter after the digit", () => {
    const parsed = parsePrompt(readFixture("blocked__codex-trust-folder__text.txt"));
    expect(parsed).toMatchObject({
      question: "Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt injection. Trusting the directory allows project-local config, hooks, and exec policies to load.",
      answer: "digit",
      confirm: true,
      options: [
        { index: 1, label: "Yes, continue", selected: true },
        { index: 2, label: "No, quit", selected: false },
      ],
    });
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

describe("an unnumbered cursor menu", () => {
  test("parses Claude Code's folder-trust question, cursor and all", () => {
    const parsed = parsePrompt(readFixture("blocked__trust-folder__text.txt"));

    expect(parsed).not.toBeNull();
    expect(parsed!.answer).toBe("cursor");
    expect(parsed!.question).toBe(
      "Quick safety check: Is this a project you created or one you trust? (Like your own code, a " +
        "well-known open source project, or work from your team). If not, take a moment to review " +
        "what's in this folder first.",
    );
    // What sits between the question and the rows is context, same as codex's
    // command block — it is the sentence that says what trusting means. The
    // dialog's block above the question comes first: see the next test.
    expect(parsed!.context).toEqual([
      "Accessing workspace:",
      "/private/tmp/trust-probe.vt9D",
      "Claude Code'll be able to read, edit, and execute files here.",
      "Security guide",
    ]);
    expect(parsed!.options).toEqual([
      { index: 1, label: "No, exit", selected: false },
      { index: 2, label: "Yes, I trust this folder", selected: true },
    ]);
  });

  // Pre-release bug hunt, B86: the card offered "Yes, I trust this folder"
  // without the folder, because the dialog's block above was only read for a
  // question ending in "?" and this one ends "…first.".
  test("the folder-trust card names the folder being trusted", () => {
    const parsed = parsePrompt(readFixture("blocked__trust-folder__text.txt"))!;
    expect(parsed.context?.slice(0, 2)).toEqual(["Accessing workspace:", "/private/tmp/trust-probe.vt9D"]);
    // No rule above the question, no dialog block: nothing past the prompt is borrowed.
    const unbounded = readFixture("blocked__trust-folder__text.txt").replace(/^─+$/mu, "");
    expect(parsePrompt(unbounded)!.context).toEqual([
      "Claude Code'll be able to read, edit, and execute files here.",
      "Security guide",
    ]);
  });

  test("a numbered menu still answers by digit", () => {
    expect(parsePrompt(readFixture("blocked__w4-p2__text.txt"))!.answer).toBe("digit");
  });

  test("needs the rows to line up and exactly one cursor", () => {
    // Prose above a confirm hint: the shell's `❯` echo and an indented note
    // are not a menu, because their labels start in different columns.
    const echo = ["❯ claude", "   Loading…", "", " Enter to confirm · Esc to cancel"].join("\n");
    expect(parsePrompt(echo)).toBeNull();
    // Two lit rows is a corrupted screen, not a choice.
    const two = ["Pick?", "", " ❯ One", " ❯ Two", "", " Enter to confirm"].join("\n");
    expect(parsePrompt(two)).toBeNull();
    // Aligned rows with a hint but no cursor at all is a list, not a menu.
    const none = ["Pick?", "", "   One", "   Two", "", " Enter to confirm"].join("\n");
    expect(parsePrompt(none)).toBeNull();
  });

  test("without the confirm hint, aligned rows with a cursor are prose", () => {
    // Claude Code's composer is a `❯` on its own line above the status bar;
    // the glyph alone must never make a menu (see the header comment).
    const composer = ["Done. Anything else?", "", " ❯ ", "   next step", ""].join("\n");
    expect(parsePrompt(composer)).toBeNull();
  });
});
