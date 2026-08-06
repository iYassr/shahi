/**
 * The situations worth testing, written down.
 *
 * The suite used to run against the live herdr session, which made it
 * non-deterministic (the first row changes between runs), unable to stage
 * anything (there is no blocked agent to hand when you need one), and — as it
 * turned out — able to type into somebody's actual work. These are the same
 * shapes off a real session, held still.
 *
 * Everything here is a builder rather than a constant, so a test can take a
 * scenario and change the one thing it cares about.
 */
import type {
  DashboardPane,
  LogMessage,
  ParsedPrompt,
  Session,
  Space,
  SpaceTab,
} from "@shahi/shared";

export interface Scenario {
  session: Session;
  /** Transcripts by pane. A pane absent from here has none, like a shell. */
  transcripts: Record<string, LogMessage[]>;
  /** Live prompts by pane, as the poller would report them. */
  prompts: Record<string, ParsedPrompt>;
  /** Raw screens by pane, for the terminal tab. */
  screens: Record<string, string>;
}

const space = (over: Partial<Space> & { workspaceId: string; label: string }): Space => ({
  status: "idle",
  paneCount: 1,
  tabCount: 1,
  focused: false,
  cwd: "~/project",
  cwdPath: "/home/x/project",
  ...over,
});

const tab = (over: Partial<SpaceTab> & { tabId: string; workspaceId: string }): SpaceTab => ({
  label: "1",
  number: 1,
  status: "idle",
  paneCount: 1,
  focused: false,
  ...over,
});

export const pane = (
  over: Partial<DashboardPane> & { paneId: string; workspaceId: string },
): DashboardPane => ({
  workspaceLabel: "project",
  tabId: `${over.workspaceId}:t1`,
  status: "idle",
  agent: "claude",
  title: "A task",
  cwd: "~/project",
  focused: false,
  hasPrompt: false,
  isAgent: true,
  prompt: null,
  preview: null,
  activity: null,
  ...over,
});

/** The prompt shape Claude Code's question tool renders. */
export const question = (): ParsedPrompt => ({
  question: "Which colour do you prefer?",
  options: [
    { index: 1, label: "Red", selected: true, detail: "Warm, high-contrast." },
    { index: 2, label: "Green", selected: false, detail: "Reads as success." },
    { index: 3, label: "Blue", selected: false },
    { index: 4, label: "Type something.", selected: false },
  ],
});

/**
 * The shape codex renders when it wants to run something.
 *
 * The question, the reason, and a command line routinely longer than the
 * screen — captured from a live approval, because taking the nearest paragraph
 * as the question gave a card headed by eight wrapped lines of shell with the
 * answers pushed out of view.
 */
export const approval = (): ParsedPrompt => ({
  question: "Would you like to run the following command?",
  context: [
    "Environment: local",
    "Reason: May I inspect the failing E2E tests to separate product defects from harness failures?",
    "$ sed -n '1,180p' e2e/stress.spec.ts; sed -n '1,240p' e2e/playwright.config.ts; git diff --stat",
  ],
  options: [
    { index: 1, label: "Yes, proceed (y)", selected: true },
    { index: 2, label: "Yes, and don't ask again for commands that start with `sed` (p)", selected: false },
    { index: 3, label: "No, and tell Codex what to do differently (esc)", selected: false },
  ],
});

/** The prompt shape a permission request renders. */
export const permission = (): ParsedPrompt => ({
  question: "Do you want to make this edit to index.ts?",
  options: [
    { index: 1, label: "Yes", selected: true },
    { index: 2, label: "Yes, and don't ask again this session", selected: false },
    { index: 3, label: "No, and tell Claude what to do differently", selected: false },
  ],
});

/**
 * A conversation containing one of everything the contract allows.
 *
 * Deliberately exhaustive: the reader dropped `AskUserQuestion` entirely for
 * weeks because no fixture had ever contained one. Every block kind in
 * `LogBlock` appears here, and `contract.test.ts` fails if a kind is added
 * without one.
 */
export function everyBlockKind(): LogMessage[] {
  return [
    {
      id: "m1",
      role: "you",
      at: 1_700_000_000_000,
      blocks: [{ kind: "text", text: "Look at the parser and tell me what is wrong with it." }],
    },
    {
      id: "m2",
      role: "agent",
      at: 1_700_000_001_000,
      blocks: [
        { kind: "thinking", text: "The run detection assumes contiguous lines." },
        {
          kind: "text",
          text:
            "Three things are wrong.\n\n" +
            "1. **Contiguity** — the run breaks on any描述 line.\n" +
            "2. `OPTION_RE` misses the `›` codex draws.\n" +
            "3. A separator ends the run early.\n\n" +
            "| what | where |\n|---|---|\n| runs | prompt-parser.ts |\n| glyphs | OPTION_RE |\n\n" +
            "```ts\nconst OPTION_RE = /^\\s*(\\d+)\\.\\s+(.+)$/;\n```\n",
        },
        {
          kind: "tool",
          name: "Read",
          summary: "/home/x/project/src/prompt-parser.ts",
          file: { path: "/home/x/project/src/prompt-parser.ts", name: "prompt-parser.ts" },
          result: { text: "const OPTION_RE = …", isError: false, truncated: false, images: [] },
        },
        {
          kind: "tool",
          name: "Bash",
          summary: "bun test server/lib",
          result: { text: "184 pass\n0 fail", isError: false, truncated: false, images: [] },
        },
        {
          kind: "tool",
          name: "Bash",
          summary: "bun run missing-script",
          result: { text: "error: Script not found", isError: true, truncated: false, images: [] },
        },
        {
          kind: "tool",
          name: "Grep",
          summary: "pattern: OPTION_RE",
          result: { text: "…", isError: false, truncated: true, images: [] },
        },
        {
          kind: "tool",
          name: "Read",
          summary: "/home/x/project/shot.png",
          file: { path: "/home/x/project/shot.png", name: "shot.png" },
          result: { text: "", isError: false, truncated: false, images: ["m2:r0"] },
        },
        {
          kind: "tool",
          name: "AskUserQuestion",
          summary: "Which colour do you prefer?",
          questions: [
            {
              text: "Which colour do you prefer?",
              options: [
                { label: "Red", description: "Warm, high-contrast." },
                { label: "Green" },
              ],
            },
          ],
          result: null,
        },
        { kind: "image", mediaType: "image/png", ref: "m2:0" },
      ],
    },
    {
      id: "m3",
      role: "system",
      at: 1_700_000_002_000,
      blocks: [{ kind: "text", text: "Session resumed." }],
    },
  ];
}

/** A long conversation, for pagination and scrolling. */
export function longConversation(count = 140): LogMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `long-${i}`,
    role: i % 2 === 0 ? ("you" as const) : ("agent" as const),
    at: 1_700_000_000_000 + i * 1_000,
    blocks: [
      {
        kind: "text" as const,
        text:
          i % 2 === 0
            ? `Message ${i + 1}: what about this one?`
            : `Message ${i + 1}: ` + "a sentence that takes a little room. ".repeat(6),
      },
    ],
  }));
}

const SCREEN =
  "[38;5;180m❯[0m bun test\n\n  184 pass\n  0 fail\n\n" +
  "[38;5;180m✻[0m Baked for 8m 34s\n" +
  "─".repeat(146) +
  "\n❯ \n" +
  "─".repeat(146) +
  "\n  x@host:~/project (main) ctx:27% [INSERT]\n";

/** The everyday case: a few agents, one of them waiting on a human. */
export function busySession(): Scenario {
  const panes: DashboardPane[] = [
    pane({
      paneId: "w1:p1",
      workspaceId: "w1",
      workspaceLabel: "project",
      status: "blocked",
      title: "Refactor the parser",
      hasPrompt: true,
      prompt: question(),
    }),
    pane({
      paneId: "w1:p2",
      workspaceId: "w1",
      workspaceLabel: "project",
      status: "working",
      title: "Convert PDF to markdown",
      tabId: "w1:t2",
      preview: "Message 140: a sentence that takes a little room.",
      activity: { verb: "Baking", elapsed: "8m 34s", detail: "26.0k tokens" },
    }),
    pane({
      paneId: "w1:p3",
      workspaceId: "w1",
      workspaceLabel: "project",
      status: "idle",
      agent: null,
      isAgent: false,
      title: null,
      tabId: "w1:t3",
    }),
    pane({
      paneId: "w2:p1",
      workspaceId: "w2",
      workspaceLabel: "notes",
      status: "done",
      agent: "codex",
      title: "Summarise the meeting",
      preview: "Done — the summary is in notes/2026-08-05.md, three decisions and one open question.",
    }),
  ];

  return {
    session: {
      version: "0.7.5",
      protocol: 17,
      defaultGrouping: null,
      workspaces: [
        space({ workspaceId: "w1", label: "project", status: "blocked", paneCount: 3, tabCount: 3 }),
        space({
          workspaceId: "w2",
          label: "notes",
          status: "done",
          cwd: "~/notes",
          cwdPath: "/home/x/notes",
        }),
      ],
      tabs: [
        tab({ tabId: "w1:t1", workspaceId: "w1", status: "blocked" }),
        tab({ tabId: "w1:t2", workspaceId: "w1", label: "2", number: 2, status: "working" }),
        tab({ tabId: "w1:t3", workspaceId: "w1", label: "shell", number: 3 }),
        tab({ tabId: "w2:t1", workspaceId: "w2", status: "done" }),
      ],
      panes,
      focusedPaneId: "w1:p1",
    },
    transcripts: {
      "w1:p1": everyBlockKind(),
      "w1:p2": longConversation(),
      "w2:p1": everyBlockKind().slice(0, 2),
    },
    prompts: { "w1:p1": question() },
    screens: { "w1:p1": SCREEN, "w1:p2": SCREEN, "w1:p3": SCREEN, "w2:p1": SCREEN },
  };
}

/** Nothing running at all — the empty state nobody remembers to design. */
export function emptySession(): Scenario {
  return {
    session: {
      version: "0.7.5",
      protocol: 17,
      defaultGrouping: null,
      workspaces: [],
      tabs: [],
      panes: [],
      focusedPaneId: null,
    },
    transcripts: {},
    prompts: {},
    screens: {},
  };
}

/** Every agent blocked at once, each asking something different. */
export function everyoneWaiting(): Scenario {
  const base = busySession();
  const prompts = [question(), permission(), approval()];
  const panes = base.session.panes
    .filter((p) => p.isAgent)
    .map((p, i) => ({ ...p, status: "blocked" as const, hasPrompt: true, prompt: prompts[i]! }));

  return {
    ...base,
    session: { ...base.session, panes },
    prompts: Object.fromEntries(panes.map((p, i) => [p.paneId, prompts[i]!])),
  };
}

/** A great many agents, for scrolling and grouping. */
export function crowdedSession(): Scenario {
  const base = busySession();
  const panes = Array.from({ length: 28 }, (_, i) =>
    pane({
      paneId: `w${(i % 4) + 1}:p${i}`,
      workspaceId: `w${(i % 4) + 1}`,
      workspaceLabel: ["project", "notes", "infra", "sandbox"][i % 4]!,
      status: (["idle", "working", "done", "idle"] as const)[i % 4]!,
      agent: (["claude", "codex", "pi", "claude"] as const)[i % 4]!,
      title: `Task number ${i + 1}`,
    }),
  );
  const workspaces = ["project", "notes", "infra", "sandbox"].map((label, i) =>
    space({ workspaceId: `w${i + 1}`, label, paneCount: 7, tabCount: 7 }),
  );

  return {
    ...base,
    session: { ...base.session, workspaces, panes },
    // The first several have transcripts, because a walkthrough opens them and
    // a missing one is a 404 the browser logs as an error — real behaviour, but
    // not what a test about navigation is asking about.
    transcripts: Object.fromEntries(
      panes.slice(0, 6).map((p) => [p.paneId, everyBlockKind().slice(0, 2)]),
    ),
    screens: Object.fromEntries(panes.map((p) => [p.paneId, base.screens["w1:p1"]!])),
  };
}

export const SCENARIOS = {
  busy: busySession,
  empty: emptySession,
  waiting: everyoneWaiting,
  crowded: crowdedSession,
} satisfies Record<string, () => Scenario>;

export type ScenarioName = keyof typeof SCENARIOS;
