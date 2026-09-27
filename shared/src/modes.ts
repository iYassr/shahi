/**
 * How much an agent is allowed to do without asking.
 *
 * Every agent has this setting and every agent spells it differently, so the
 * choice belongs at the moment you start one rather than three prompts later
 * when it stops to ask about a `mkdir`. On a phone that matters more than on a
 * desktop: answering permission prompts one at a time through a dashboard is
 * exactly the friction this app exists to remove.
 *
 * The flags were read out of `--help` on the machine that runs them, not from
 * memory. They differ between versions; `docs/operations.md` says how to check.
 * An agent kind that is not listed here gets no options and starts with its own
 * defaults, which is the right failure — inventing a flag would mean an agent
 * that refuses to start at all.
 */

export interface AgentMode {
  /** Stable id, stored and sent over the wire. */
  id: string;
  label: string;
  /** What it means in practice, in one line. */
  description: string;
  /** Appended to the agent's command line. */
  args: string[];
  /** True where nothing will be asked before it acts. */
  unsafe?: boolean;
}

const CLAUDE: AgentMode[] = [
  {
    id: "default",
    label: "Ask me",
    description: "Asks before unapproved changes and commands; saved permission rules still apply.",
    // Claude persists the last mode selected in its TUI. No flag therefore
    // means "whatever this machine used last", which can be auto approval.
    // `manual` is Claude 2.1.261's explicit ask-before-tools contract.
    args: ["--permission-mode", "manual"],
  },
  {
    id: "acceptEdits",
    label: "Auto-accept edits",
    description: "Approves edits and common file commands in the working folders; asks for other unapproved actions.",
    args: ["--permission-mode", "acceptEdits"],
  },
  {
    id: "plan",
    label: "Plan first",
    description: "Explores and plans without editing source files, then asks before implementation.",
    args: ["--permission-mode", "plan"],
  },
  {
    id: "bypass",
    label: "Skip all permissions",
    description: "Bypasses normal permission checks and can run commands as you. Claude may still require some confirmations.",
    args: ["--dangerously-skip-permissions"],
    unsafe: true,
  },
];

const CODEX: AgentMode[] = [
  {
    id: "default",
    label: "Ask me",
    description: "Starts read-only and asks before making changes.",
    args: ["--sandbox", "read-only", "--ask-for-approval", "on-request", "-c", 'approvals_reviewer="user"'],
  },
  {
    id: "on-request",
    label: "Agent decides",
    description: "Can edit and run commands in the workspace sandbox; asks you when it requests extra access.",
    args: ["--sandbox", "workspace-write", "--ask-for-approval", "on-request", "-c", 'approvals_reviewer="user"'],
  },
  {
    id: "full-auto",
    label: "Full auto",
    description: "Runs commands without asking, inside its own sandbox.",
    // Keep the reviewer explicit in every mode, including modes which never
    // ask. Codex 0.157's shared daemon cannot apply this invocation override
    // and runs an embedded server instead, preserving the pane's hook/session
    // ownership and exact process-file Reader lookup. Without it these two
    // modes silently attached to a daemon launched by another terminal.
    args: ["--sandbox", "workspace-write", "--ask-for-approval", "never", "-c", 'approvals_reviewer="user"'],
  },
  {
    id: "bypass",
    label: "Skip sandbox and prompts",
    description: "Never asks and does not sandbox. Anything it runs, runs as you.",
    args: ["--dangerously-bypass-approvals-and-sandbox", "-c", 'approvals_reviewer="user"'],
    unsafe: true,
  },
];

const MODES: Record<string, AgentMode[]> = {
  claude: CLAUDE,
  codex: CODEX,
};

/** The modes offered for an agent kind, or none where they are not known. */
export function modesFor(kind: string | null | undefined): AgentMode[] {
  if (!kind) return [];
  return MODES[kind.toLowerCase()] ?? [];
}

/** Resolves a stored choice back to its flags, ignoring anything unrecognised. */
export function argsForMode(kind: string, modeId: string | null): string[] {
  if (!modeId) return [];
  return modesFor(kind).find((mode) => mode.id === modeId)?.args ?? [];
}
