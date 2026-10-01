/**
 * The Read-versus-Screen comparison, on screens in the shapes measured on
 * Claude Code 2.1.286 and Codex 0.157.1 (October 2026), with invented text.
 */
import { describe, expect, test } from "bun:test";
import type { LogMessage } from "@shahi/shared";
import { compare, disagreement, plain, screenLines, screenTasks } from "./reader-parity";

const agent = (text: string, id = "a"): LogMessage => ({ id, role: "agent", at: 0, blocks: [{ kind: "text", text }] });
const you = (text: string): LogMessage => ({ id: "y", role: "you", at: 0, blocks: [{ kind: "text", text }] });

const CLAUDE = [
  "❯ please tidy the release notes before shipping",
  "",
  "⏺ The notes now say **which build** carries the fix, and the",
  "  `--beta` channel gets it first.",
  "",
  "⏺ Bash(bun run test)",
  "  ⎿  1283 pass",
  "     0 fail and some long tool output that Reader keeps whole",
  "",
  "⏺ Read 3 files (ctrl+o to expand)",
  "",
  "⏺ Here is the table of what changed in this release:",
  "  ┌──────────┬──────────┐",
  "  │ what     │ where    │",
  "  └──────────┴──────────┘",
  "  Everything else is unchanged from the previous release.",
  "",
  "✻ Shipping the release… (2m 3s · ↓ 4.1k tokens)",
  "  ⎿  ✔ Write the release notes",
  "     ◼ Build the package for the phone",
  "     ◻ Publish to the beta channel",
  "",
  "──────────────────────────────────────────",
  "❯ and then tell me when it is done please",
  "──────────────────────────────────────────",
  "  ⏵⏵ accept edits on (shift+tab to cycle)                         ✔ Update installed · Restart to apply",
].join("\n");

describe("Claude Code's screen", () => {
  test("compares prose and the person's sent messages, not steps, tables' rules, chrome or the composer", () => {
    expect(screenLines(CLAUDE, "claude")).toEqual([
      "please tidy the release notes before shipping",
      "the notes now say which build carries the fix and the",
      "beta channel gets it first",
      "here is the table of what changed in this release",
      "everything else is unchanged from the previous release",
    ]);
  });

  test("reads the task list under the spinner, and only a list", () => {
    expect(screenTasks(CLAUDE)).toEqual([
      { status: "completed", subject: "Write the release notes" },
      { status: "in_progress", subject: "Build the package for the phone" },
      { status: "pending", subject: "Publish to the beta channel" },
    ]);
    expect(screenTasks("⏺ Bash(ls)\n  ⎿  ✔ one result line")).toEqual([]);
  });

  test("a wrapped line of a paragraph is found in the paragraph, whatever its markup", () => {
    const log = {
      messages: [you("please tidy the release notes before shipping"), agent("The notes now say **which build** carries the fix, and the `--beta` channel gets it first."),
        agent("Here is the table of what changed in this release:\n\n| what | where |\n\nEverything else is unchanged from the previous release.")],
      tasks: [{ id: "1", subject: "Write the release notes", status: "completed" as const }, { id: "2", subject: "Build the package for the phone", status: "in_progress" as const },
        { id: "3", subject: "Publish to the beta channel", status: "pending" as const }],
    };
    const parity = compare(CLAUDE, "claude", log);
    expect(parity).toMatchObject({ lines: 5, found: 5, newestMissing: 0, tasks: 3, tasksFound: 3 });
    expect(disagreement(parity)).toBeNull();
  });

  // The three things the owner found by looking (October 2026).
  test("a Reader on a stale transcript, without the task list, or without a message typed mid-turn disagrees", () => {
    const stale = compare(CLAUDE, "claude", { messages: [agent("Yesterday's reply, from the old transcript.")], tasks: [] });
    expect(disagreement(stale)).toBe("Screen lists 3 tasks, Read has 0 of them");
    expect(disagreement({ ...stale, tasks: 0 })).toBe("Read lacks 3 of the 3 newest lines on Screen");
    const noQueued = compare(CLAUDE, "claude", {
      messages: [agent("The notes now say which build carries the fix, and the --beta channel gets it first."),
        agent("Here is the table of what changed in this release:"), agent("Everything else is unchanged from the previous release.")],
    });
    expect(noQueued).toMatchObject({ lines: 5, found: 4, newestMissing: 0 });
    expect(noQueued.missing).toEqual(["please tidy the release notes before shipping"]);
  });

  test("a task Screen shortens with … is found by its start", () => {
    const screen = "✻ Working…\n  ⎿  ◼ Build the package for the ph…\n     ◻ Publish";
    expect(compare(screen, "claude", { messages: [], tasks: [{ id: "1", subject: "Build the package for the phone", status: "in_progress" }, { id: "2", subject: "Publish", status: "pending" }] }))
      .toMatchObject({ tasks: 2, tasksFound: 2 });
  });
});

describe("Codex's screen", () => {
  const CODEX = [
    "› make the parser stricter about cursor rows",
    "",
    "• Inspect the parser and its tests",
    "  └ server/lib/prompt-parser.ts",
    "",
    "• Ran bun test server/lib/prompt-parser.test.ts",
    "",
    "• The parser now requires exactly one cursor row before it",
    "  offers any answers for a menu.",
    "",
    "› Ask Codex to do anything",
  ].join("\n");

  test("a step titled in words is a step because output sits under it", () => {
    expect(screenLines(CODEX, "codex")).toEqual([
      "make the parser stricter about cursor rows",
      "the parser now requires exactly one cursor row before it",
      "offers any answers for a menu",
    ]);
  });
});

test("an agent whose screen shape is unknown is not compared", () => {
  expect(screenLines("anything at all on this screen today", "opencode")).toEqual([]);
});

test("plain keeps letters and digits in any script", () => {
  expect(plain("**Ready** — 0.3.18 (build 31), مرحبا")).toBe("ready 0 3 18 build 31 مرحبا");
});
