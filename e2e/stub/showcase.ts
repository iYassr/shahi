/**
 * A believable working day, for App Store screenshots and the product video.
 *
 * The tests' scenarios are built to provoke edge cases ("A task", "Which
 * colour do you prefer?"), which is right for tests and wrong for a picture
 * of the product. This one is invented whole: four projects, twelve agents
 * across five providers, one waiting on an edit, a conversation worth
 * reading, its diff, and its terminal. Nothing here came from a real session.
 */
import type { DashboardPane, LogMessage, ParsedPrompt } from "@shahi/shared";
import { pane, space, tab, type RepositoryChanges, type Scenario } from "./data";

/** Read when the scenario is chosen, so the list says "2m" and "12m" rather than a fixed date. */
let AT = Date.now();
const minutes = (n: number) => AT - n * 60_000;

const offlineEdit = (): ParsedPrompt => ({
  question: "Do you want to make this edit to queue.ts?",
  answer: "digit",
  promptId: "showcase-queue-edit",
  context: [
    [
      "Edit file",
      "src/sync/queue.ts",
      "╌".repeat(44),
      "  14    async function flush(queue: Change[]) {",
      "  15 -    for (const c of queue) await send(c);",
      "  15 +    for (const c of queue) {",
      "  16 +      if (!online()) return keep(c);",
      "  17 +      await send(c);",
      "  18 +    }",
      "  19    }",
      "╌".repeat(44),
    ].join("\n"),
  ],
  options: [
    { index: 1, label: "Yes", selected: true },
    { index: 2, label: "Yes, allow all edits during this session (shift+tab)", selected: false },
    { index: 3, label: "No, and tell Claude what to do differently (esc)", selected: false },
  ],
});

const flakyTest = (): LogMessage[] => [
  { id: "f1", role: "you", at: minutes(12), blocks: [{ kind: "text", text: "Why is the due-date test flaky on CI? Fix it." }] },
  {
    id: "f2", role: "agent", at: minutes(11),
    blocks: [
      { kind: "thinking", text: "The test passes locally and fails on CI only sometimes, so it depends on something outside the code: time, order or the network." },
      { kind: "tool", name: "Read", summary: "src/tasks/due.ts", file: { path: "/Users/maya/code/tasks-web/src/tasks/due.ts", name: "due.ts" }, result: { text: "export function isDueSoon(task: Task) {…}", isError: false, truncated: false, images: [] } },
      { kind: "tool", name: "Grep", summary: "pattern: new Date\\(\\)", result: { text: "src/tasks/due.ts:4", isError: false, truncated: false, images: [] } },
      {
        kind: "text",
        text:
          "Found it. `isDueSoon()` reads the real clock, and the test's task is due at 18:00. Runs between 16:00 and 18:00 see a **due soon** badge: about one run in ten.\n\n" +
          "The fix is to pass the clock in, so the test can fix the time:\n\n" +
          "```ts\nfunction isDueSoon(task: Task, now = new Date()) {\n  const left = task.due.getTime() - now.getTime();\n  return left > 0 && left <= 2 * HOUR;\n}\n```",
      },
      { kind: "tool", name: "Edit", summary: "src/tasks/due.ts", file: { path: "/Users/maya/code/tasks-web/src/tasks/due.ts", name: "due.ts" }, result: { text: "Updated", isError: false, truncated: false, images: [] } },
      { kind: "tool", name: "Edit", summary: "src/tasks/badge.test.ts", file: { path: "/Users/maya/code/tasks-web/src/tasks/badge.test.ts", name: "badge.test.ts" }, result: { text: "Updated", isError: false, truncated: false, images: [] } },
      { kind: "tool", name: "Bash", summary: "bun test src/tasks --rerun-each 50", result: { text: "50 runs: 412 pass, 0 fail", isError: false, truncated: false, images: [] } },
      {
        kind: "text",
        text:
          "Fixed. The badge test now passes a fixed clock, and **50 runs in a row pass** where one in ten failed before.\n\n" +
          "| file | change |\n|---|---|\n| `due.ts` | takes `now`, defaults to the real clock |\n| `badge.test.ts` | pins `now` to 15:00 |\n\nWant me to look for other tests that read the clock?",
      },
    ],
  },
];

const offlineSync = (): LogMessage[] => [
  { id: "o1", role: "you", at: minutes(6), blocks: [{ kind: "text", text: "Queue task changes made offline and send them when the phone reconnects." }] },
  {
    id: "o2", role: "agent", at: minutes(4),
    blocks: [
      { kind: "tool", name: "TodoWrite", summary: "3 tasks", todos: [
        { content: "Keep changes in a local queue", status: "completed" },
        { content: "Flush the queue when the phone is back online", status: "in_progress" },
        { content: "Show a pending badge until a change is sent", status: "pending" },
      ], result: null },
      { kind: "tool", name: "Read", summary: "src/sync/queue.ts", file: { path: "/Users/maya/code/tasks-mobile/src/sync/queue.ts", name: "queue.ts" }, result: { text: "…", isError: false, truncated: false, images: [] } },
      { kind: "text", text: "Changes now land in a local queue first. Next, `flush()` has to stop at the first change it cannot send, so nothing is lost or sent twice." },
    ],
  },
];

const review = (): LogMessage[] => [
  { id: "r1", role: "you", at: minutes(40), blocks: [{ kind: "text", text: "Review PR #128 before I merge it." }] },
  {
    id: "r2", role: "agent", at: minutes(31),
    blocks: [
      { kind: "tool", name: "exec", summary: "gh pr diff 128", result: { text: "…", isError: false, truncated: true, images: [] } },
      { kind: "text", text: "Two issues before this merges:\n\n1. **Off by one on the last page.** `pages = total / size` drops the remainder; use `Math.ceil`.\n2. **Missing index.** The new query sorts by `created_at` on 2M rows with no index.\n\nEverything else looks good: tests cover both directions and the cursor is opaque." },
    ],
  },
];

const notes = (): LogMessage[] => [
  { id: "n1", role: "you", at: minutes(55), blocks: [{ kind: "text", text: "Write the release notes for 2.4." }] },
  { id: "n2", role: "agent", at: minutes(50), blocks: [{ kind: "text", text: "Done. The notes are in `CHANGELOG.md` and `release-notes/2.4.md`: offline sync, faster search and the new settings screen." }] },
];

const SHOWCASE_CHANGES: RepositoryChanges = {
  list: {
    repository: { name: "tasks-web", path: "~/code/tasks-web", branch: "fix/due-soon-clock", commit: "8c41d07" },
    files: [
      { path: "src/tasks/due.ts", status: "modified", added: 12, removed: 6 },
      { path: "src/tasks/badge.test.ts", status: "modified", added: 4, removed: 1 },
    ],
    omitted: 0,
  },
  diffs: {
    "src/tasks/due.ts": {
      path: "src/tasks/due.ts", status: "modified", omitted: 0,
      lines: [
        "@@ -1,9 +1,12 @@",
        " import { HOUR } from \"../time\";",
        " import type { Task } from \"./task\";",
        " ",
        "-export function isDueSoon(task: Task) {",
        "-  const left = task.due.getTime()",
        "-    - Date.now();",
        "+export function isDueSoon(",
        "+  task: Task,",
        "+  now = new Date(),",
        "+) {",
        "+  const left = task.due.getTime()",
        "+    - now.getTime();",
        "   return left > 0 && left <= 2 * HOUR;",
        " }",
        " ",
        "@@ -24,7 +27,10 @@",
        "-export function badgeFor(task: Task) {",
        "-  if (late(task)) return \"overdue\";",
        "-  if (isDueSoon(task)) return \"soon\";",
        "+export function badgeFor(",
        "+  task: Task,",
        "+  now = new Date(),",
        "+) {",
        "+  if (late(task, now)) return \"overdue\";",
        "+  if (isDueSoon(task, now)) return \"soon\";",
        "   return \"upcoming\";",
        " }",
      ],
    },
    "src/tasks/badge.test.ts": {
      path: "src/tasks/badge.test.ts", status: "modified", omitted: 0,
      lines: [
        "@@ -12,7 +12,10 @@ describe(\"due badge\", () => {",
        "   test(\"shows due soon two hours ahead\", () => {",
        "     const task = taskDueAt(\"18:00\");",
        "-    expect(badgeFor(task)).toBe(\"due-soon\");",
        "+    const at = (time: string) => new Date(`2026-10-16T${time}`);",
        "+    expect(badgeFor(task, at(\"16:30\"))).toBe(\"due-soon\");",
        "+    expect(badgeFor(task, at(\"15:00\"))).toBe(\"upcoming\");",
        "+    expect(badgeFor(task, at(\"18:30\"))).toBe(\"overdue\");",
        "   });",
        " });",
      ],
    },
  },
};

const E = "\x1b[";
const dim = (t: string) => `${E}38;5;245m${t}${E}0m`;
const amber = (t: string) => `${E}38;5;180m${t}${E}0m`;
const green = (t: string) => `${E}38;5;114m${t}${E}0m`;
const red = (t: string) => `${E}38;5;174m${t}${E}0m`;
const SCREEN = [
  `${amber(">")} Why is the due-date test flaky on CI? Fix it.`,
  "",
  `${green("●")} Read(src/tasks/due.ts)`,
  dim("  ⎿  Read 31 lines"),
  "",
  `${green("●")} Search(pattern: "new Date\\(\\)", path: "src")`,
  dim("  ⎿  Found 1 file"),
  "",
  `${green("●")} Found it. isDueSoon() reads the real clock, and`,
  "  the test's task is due at 18:00. Runs between 16:00",
  "  and 18:00 see a due soon badge: about one run in ten.",
  "",
  `${green("●")} Update(src/tasks/due.ts)`,
  dim("  ⎿  Updated with 12 additions and 6 removals"),
  `     4 ${red("-export function isDueSoon(task: Task) {")}`,
  `     4 ${green("+export function isDueSoon(")}`,
  `     5 ${green("+  task: Task,")}`,
  `     6 ${green("+  now = new Date(),")}`,
  "",
  `${green("●")} Bash(bun test src/tasks --rerun-each 50)`,
  `  ⎿  ${green("412 pass")}`,
  "     0 fail",
  "",
  `${green("●")} Fixed. The badge test now passes a fixed clock,`,
  "  and 50 runs in a row pass where one in ten failed.",
  "",
  "  Want me to look for other tests that read the clock?",
  "",
  `${amber("✻")} ${dim("Worked for 8m 34s")}`,
  "",
  "─".repeat(58),
  `${amber(">")} `,
  "─".repeat(58),
  dim("  ~/code/tasks-web (fix/due-soon-clock) · ctx 31%"),
].join("\n") + "\n";

/** Maya's day: four projects and twelve agents, one of them waiting on her. */
export function showcaseSession(): Scenario {
  AT = Date.now();
  const panes: DashboardPane[] = [
    pane({ paneId: "w3:p4", workspaceId: "w3", workspaceLabel: "tasks-mobile", tabId: "w3:t4", status: "blocked", agent: "claude", title: "Add offline sync", cwd: "~/code/tasks-mobile", hasPrompt: true, prompt: offlineEdit(), preview: "Changes now land in a local queue first.", lastMessageAt: AT - 20_000, startedAt: minutes(6) }),
    pane({ paneId: "w1:p4", workspaceId: "w1", workspaceLabel: "tasks-web", tabId: "w1:t4", status: "done", agent: "claude", title: "Fix the flaky due-date test", cwd: "~/code/tasks-web", preview: "Fixed. The badge test now passes a fixed clock.", lastMessageAt: minutes(1), startedAt: minutes(12) }),
    pane({ paneId: "w2:p1", workspaceId: "w2", workspaceLabel: "tasks-api", tabId: "w2:t1", status: "done", agent: "codex", title: "Review PR #128: pagination", cwd: "~/code/tasks-api", preview: "Two issues: an off-by-one on the last page and a missing index.", lastMessageAt: minutes(31), startedAt: minutes(40) }),
    pane({ paneId: "w1:p2", workspaceId: "w1", workspaceLabel: "tasks-web", tabId: "w1:t2", status: "working", agent: "cursor", title: "Move settings to the new form library", cwd: "~/code/tasks-web", preview: "Six of nine forms converted; the last three use custom validation.", lastMessageAt: minutes(2), startedAt: minutes(25), activity: { verb: "Converting", elapsed: "11m 02s", detail: "41.3k tokens" } }),
    pane({ paneId: "w4:p1", workspaceId: "w4", workspaceLabel: "docs", tabId: "w4:t1", status: "done", agent: "claude", title: "Write release notes for 2.4", cwd: "~/code/docs", preview: "Done. The notes are in CHANGELOG.md and release-notes/2.4.md.", lastMessageAt: minutes(50), startedAt: minutes(55) }),
    pane({ paneId: "w1:p3", workspaceId: "w1", workspaceLabel: "tasks-web", tabId: "w1:t3", status: "working", agent: "opencode", title: "Add dark mode to the dashboard", cwd: "~/code/tasks-web", preview: "Colours moved to tokens; checking contrast on the charts.", lastMessageAt: minutes(3), startedAt: minutes(20) }),
    pane({ paneId: "w2:p2", workspaceId: "w2", workspaceLabel: "tasks-api", tabId: "w2:t2", status: "working", agent: "codex", title: "Add rate limiting to the API", cwd: "~/code/tasks-api", preview: "Token bucket per key; writing the 429 tests now.", lastMessageAt: minutes(2), startedAt: minutes(18) }),
    pane({ paneId: "w2:p3", workspaceId: "w2", workspaceLabel: "tasks-api", tabId: "w2:t3", status: "working", agent: "opencode", title: "Add CSV export to reports", cwd: "~/code/tasks-api", preview: "Streaming rows so a 50k-task export never loads at once.", lastMessageAt: minutes(5), startedAt: minutes(15) }),
    pane({ paneId: "w3:p3", workspaceId: "w3", workspaceLabel: "tasks-mobile", tabId: "w3:t3", status: "done", agent: "claude", title: "Translate onboarding to Spanish", cwd: "~/code/tasks-mobile", preview: "All 46 strings translated; two need a native speaker's look.", lastMessageAt: minutes(22), startedAt: minutes(35) }),
    pane({ paneId: "w1:p5", workspaceId: "w1", workspaceLabel: "tasks-web", tabId: "w1:t5", status: "done", agent: "cursor", title: "Fix the login redirect loop", cwd: "~/code/tasks-web", preview: "The session cookie was set on the wrong path; one-line fix plus a test.", lastMessageAt: minutes(45), startedAt: minutes(60) }),
    pane({ paneId: "w2:p4", workspaceId: "w2", workspaceLabel: "tasks-api", tabId: "w2:t4", status: "done", agent: "codex", title: "Upgrade to Postgres 18", cwd: "~/code/tasks-api", preview: "Migrations pass on 18; one query plan got faster, none slower.", lastMessageAt: minutes(95), startedAt: minutes(120) }),
    pane({ paneId: "w3:p2", workspaceId: "w3", workspaceLabel: "tasks-mobile", tabId: "w3:t2", status: "done", agent: "agy", title: "Profile the cold start", cwd: "~/code/tasks-mobile", preview: "Cold start is 1.9 s; fonts and the sync check block the first frame.", lastMessageAt: minutes(70), startedAt: minutes(80) }),
  ];
  const spaces = [
    space({ workspaceId: "w1", label: "tasks-web", status: "working", paneCount: 4, tabCount: 4, cwd: "~/code/tasks-web", cwdPath: "/Users/maya/code/tasks-web" }),
    space({ workspaceId: "w2", label: "tasks-api", status: "working", paneCount: 4, tabCount: 4, cwd: "~/code/tasks-api", cwdPath: "/Users/maya/code/tasks-api" }),
    space({ workspaceId: "w3", label: "tasks-mobile", status: "blocked", paneCount: 3, tabCount: 3, cwd: "~/code/tasks-mobile", cwdPath: "/Users/maya/code/tasks-mobile" }),
    space({ workspaceId: "w4", label: "docs", status: "done", cwd: "~/code/docs", cwdPath: "/Users/maya/code/docs" }),
  ];
  return {
    agents: ["claude", "codex", "cursor", "opencode", "agy"],
    session: {
      version: "0.9.5",
      serverName: "workstation",
      protocol: 22,
      defaultGrouping: null,
      workspaces: spaces,
      tabs: panes.map((p) => tab({ tabId: p.tabId, workspaceId: p.workspaceId, status: p.status })),
      panes,
      focusedPaneId: "w1:p4",
    },
    transcripts: { "w1:p4": flakyTest(), "w3:p4": offlineSync(), "w2:p1": review(), "w4:p1": notes() },
    prompts: { "w3:p4": offlineEdit() },
    screens: Object.fromEntries(panes.map((p) => [p.paneId, SCREEN])),
    changes: { "w1:p4": SHOWCASE_CHANGES, "w3:p4": SHOWCASE_CHANGES },
  };
}
