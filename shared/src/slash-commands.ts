/**
 * Slash commands for the composer's picker.
 *
 * Typing `/compact` on a phone keyboard means a trip to the symbols layer and
 * a word spelled exactly, for something an agent's own terminal completes
 * after two letters. So the composer offers the pane's agent's commands as
 * soon as a draft starts with `/`, and inserts the one chosen. Nothing is
 * sent until the person sends it, through the ordinary send path.
 *
 * The built-in lists live here, so a computer without the `commands`
 * capability still gets them. They are short on purpose: the commands a
 * person would reach for from a phone, read from each agent's own `/` menu on
 * the version installed when they were written (see `BUILTIN`). Left out:
 * commands that end the agent (`/exit`), that only make sense at the desk
 * (`/ide`, `/copy`, `/login`), and every command that opens a full-screen
 * view. Measured on Claude Code 2.1.288: after `/usage` (which `/cost` now
 * is), the next message sent was accepted by herdr and never reached Claude,
 * because the view took it; `/status`, `/config` and `/help` open the same
 * view, and Cursor's and Antigravity's `/context` one of their own. A menu is
 * different: `/model` draws a numbered one, which the prompt card answers.
 * An agent not listed gets none — a guessed command is worse than none, the
 * same rule as the readers'.
 *
 * Custom commands the person wrote — Claude Code's `.claude/commands` and
 * skills — are read by the computer (`/api/panes/:id/commands`) and arrive
 * with their `source`.
 */

export type CommandSource = "builtin" | "user" | "project";

export interface SlashCommand {
  /** Without the slash, as it is typed: `compact`, `frontend:component`. */
  name: string;
  /** One line, as the agent's own menu describes it. */
  description: string;
  source: CommandSource;
}

/** `GET /api/panes/:id/commands`. */
export interface PaneCommands {
  commands: SlashCommand[];
}

/**
 * Per agent kind (herdr's names), name and description as the agent's `/`
 * menu showed them, read in a scratch herdr session in October 2026: Claude
 * Code 2.1.288, codex 0.160.0, cursor-agent 2026.09.28, OpenCode 1.18.33 and
 * Antigravity 1.2.12. Sent from the phone's path there, `/compact`,
 * `/context` and `/model` ran in Claude, `/status` and `/model` in codex and
 * `/compact` in OpenCode; the rest start work or a new conversation and draw
 * nothing that waits.
 */
const BUILTIN: Record<string, [name: string, description: string][]> = {
  claude: [
    ["clear", "Start a new session with empty context; previous session stays on disk (resumable with /resume)"],
    ["compact", "Free up context by summarizing the conversation so far"],
    ["context", "Visualize current context usage as a colored grid"],
    ["init", "Initialize a new CLAUDE.md file with codebase documentation"],
    ["model", "Set the AI model for Claude Code"],
    ["security-review", "Complete a security review of the pending changes on the current branch"],
  ],
  codex: [
    ["compact", "Summarize conversation to prevent hitting the context limit"],
    ["init", "Create an AGENTS.md file with instructions for Codex"],
    ["model", "Choose what model and reasoning effort to use"],
    ["new", "Start a new chat during a conversation"],
    ["plan", "Switch to Plan mode"],
    ["status", "Show current session configuration and token usage"],
  ],
  cursor: [
    ["clear", "Start a new chat session"],
    ["commit", "Ask the agent to stage and commit changes"],
    ["summarize", "Summarize the conversation to reduce context"],
  ],
  opencode: [
    ["compact", "Compact session"],
    ["new", "New session"],
    ["review", "Review changes [commit|branch|pr], defaults to uncommitted"],
    ["undo", "Undo previous message"],
  ],
  agy: [
    ["clear", "Clear conversation and start a new one"],
    ["goal", "Run until the specified goal is completely finished"],
    ["plan", "Plan carefully before executing a task"],
  ],
};

const byName = (a: SlashCommand, b: SlashCommand) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** The agent's common built-in commands, by name; none for an agent not listed. */
export function builtinCommands(agent: string | null | undefined): SlashCommand[] {
  return (BUILTIN[agent ?? ""] ?? [])
    .map(([name, description]) => ({ name, description, source: "builtin" as const }))
    .sort(byName);
}

/**
 * One list from several, the first of each name kept, by name. Callers pass
 * them in the agent's precedence: Claude Code runs a personal command over a
 * project one of the same name, so the description shown is the one that runs.
 */
export function mergeCommands(...lists: readonly SlashCommand[][]): SlashCommand[] {
  const seen = new Map<string, SlashCommand>();
  for (const list of lists) for (const command of list) if (!seen.has(command.name)) seen.set(command.name, command);
  return [...seen.values()].sort(byName);
}

/**
 * What the picker filters by: the draft after its leading `/`, while the
 * draft is still one word. A space ends it — the command is chosen and its
 * arguments follow — and so does anything not starting with `/`.
 */
export function slashQuery(draft: string): string | null {
  const match = /^\/(\S*)$/.exec(draft);
  return match ? match[1]! : null;
}

/**
 * The commands a query picks out, best first: a name that starts with it,
 * then one with a `:`-segment that does (`dra` finds `prompts:draftpr`), then
 * one containing it. Case does not matter; each group keeps the list's order.
 */
export function matchCommands(commands: readonly SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  const rank = (name: string) => {
    const n = name.toLowerCase();
    if (n.startsWith(q)) return 0;
    if (n.split(":").some((part) => part.startsWith(q))) return 1;
    return n.includes(q) ? 2 : -1;
  };
  return commands
    .map((command, i) => ({ command, i, r: rank(command.name) }))
    .filter(({ r }) => r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(({ command }) => command);
}
