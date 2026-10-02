import { expect, test } from "bun:test";
import { shownContext, shownLabels } from "./prompt-display";

// Claude Code's edit approval as the first task of build 32 drew it: a
// full-width rule, the file, `╌` rules around the diff. On the phone each rule
// wrapped into three lines of dashes above and below the code.
const editApproval = [
  "─".repeat(146),
  " Edit file\n tip.py",
  `${"╌".repeat(146)}\n  1  def split(total, tip, people):\n  2 -    return round((total + tip) / people, 2)\n  2 +    return round((total * (1 + tip)) / people, 2)\n${"╌".repeat(146)}`,
];

test("an edit approval's context loses its rules and keeps the diff between them", () => {
  expect(shownContext(editApproval)).toEqual([
    " Edit file\n tip.py",
    "  1  def split(total, tip, people):\n  2 -    return round((total + tip) / people, 2)\n  2 +    return round((total * (1 + tip)) / people, 2)",
  ]);
});

test("a code line is never broken or re-indented, however long", () => {
  const line = `    return round((total + tip) / people, 2)${" ".repeat(4)}# ${"x".repeat(200)}`;
  expect(shownContext([line])).toEqual([line]);
});

test("a rule of ASCII dashes, or one with spaces in it, is a rule too", () => {
  expect(shownContext(["-".repeat(40), "╌╌╌ ╌╌╌ ╌╌╌", "  ━━━━━━  ", "$ ls"])).toEqual(["$ ls"]);
});

test("a short dash that means something stays", () => {
  expect(shownContext(["$ git checkout main\n--\n-"])).toEqual(["$ git checkout main\n--\n-"]);
});

test("a rule with words in it is the agent's, not a separator", () => {
  expect(shownContext(["╭─── tip.py ───╮"])).toEqual(["╭─── tip.py ───╮"]);
});

test("no context shows nothing", () => {
  expect(shownContext(undefined)).toEqual([]);
  expect(shownContext(["─".repeat(80)])).toEqual([]);
});

test("a key hint at the end of an option is not shown on a phone", () => {
  expect(shownLabels([
    { label: "Yes" },
    { label: "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)" },
    { label: "No, and tell Claude what to do differently (esc)" },
  ])).toEqual([
    "Yes",
    "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session",
    "No, and tell Claude what to do differently",
  ]);
});

test("codex's and Cursor's letter keys go too, and only the last parenthesis", () => {
  expect(shownLabels([
    { label: "Yes, proceed (y)" },
    { label: "Yes, and don't ask again for commands that start with `sed` (p)" },
    { label: "No, and tell Codex what to do differently (esc)" },
  ])).toEqual([
    "Yes, proceed",
    "Yes, and don't ask again for commands that start with `sed`",
    "No, and tell Codex what to do differently",
  ]);
  expect(shownLabels([
    { label: "Run (once) (y)" },
    { label: "Add Shell(python3) to allowlist? (tab)" },
    { label: "Skip & tell the agent what to do instead (esc or n)" },
  ])).toEqual(["Run (once)", "Add Shell(python3) to allowlist?", "Skip & tell the agent what to do instead"]);
});

test("words in parentheses are not keys", () => {
  const labels = [{ label: "Yes, allow all edits (this session)" }, { label: "Keep both (A)" }, { label: "Use option (1)" }];
  expect(shownLabels(labels)).toEqual(labels.map(({ label }) => label));
});

test("a menu whose labels would read the same without their letters keeps them", () => {
  expect(shownLabels([{ label: "Plan (a)" }, { label: "Plan (b)" }])).toEqual(["Plan (a)", "Plan (b)"]);
});

test("an option that is only a key keeps it", () => {
  expect(shownLabels([{ label: "(esc)" }])).toEqual(["(esc)"]);
});
