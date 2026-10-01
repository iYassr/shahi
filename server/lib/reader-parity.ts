/**
 * Whether Read says what Screen says.
 *
 * The terminal is the ground truth: whatever an agent drew, the person saw.
 * Every Reader test compared Reader with expectations written by the people
 * who wrote Reader, so nothing noticed what it never showed: a reply that
 * continued in another transcript, Claude Code's task list, messages typed
 * mid-turn. The owner found all three by looking at Read and Screen side by
 * side (October 2026). This is that look, made mechanical.
 *
 * Screen text arrives hard-wrapped with the agent's own glyphs and markdown
 * already drawn, so both sides are reduced to letters and digits between
 * single spaces: a wrapped line of a paragraph is then a substring of that
 * paragraph, whatever the markup was.
 */
import type { LogBlock, SessionLog } from "@shahi/shared";

/** Letters and digits, lowercased, one space between runs. */
export function plain(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Claude Code's task list under its spinner: `⎿  ◼ subject`, then `◻`/`◼`/`✔` rows indented to match. */
const TASK_ROW = /^\s{2}⎿\s+([◻◼✔])\s+(.+?)\s*$|^\s{5}([◻◼✔])\s+(.+?)\s*$/u;

export interface ScreenTask { status: "pending" | "in_progress" | "completed"; subject: string }

export function screenTasks(screen: string): ScreenTask[] {
  const tasks: ScreenTask[] = [];
  for (const line of screen.split("\n")) {
    const row = TASK_ROW.exec(line);
    if (!row) continue;
    const mark = row[1] ?? row[3]!;
    tasks.push({ status: mark === "✔" ? "completed" : mark === "◼" ? "in_progress" : "pending", subject: row[2] ?? row[4]! });
  }
  // One row is a tool's result that happens to start with a mark; a list has two.
  return tasks.length >= 2 ? tasks : [];
}

/*
 * How each agent starts a block of its conversation, measured on eleven live
 * Claude Code 2.1.286 panes and three Codex 0.157.1 panes (October 2026).
 * Claude draws its prose and its tool steps both after `⏺`, and the person's
 * messages after `❯`; Codex uses `•` and `›`. A tool step is told apart by its
 * shape: `Name(arguments)`, or a counted group such as "Read 3 files". Only
 * prose and the person's messages are compared, because a tool step on Screen
 * also previews what it wrote or ran, which Reader deliberately keeps to one
 * line and the file viewer.
 */
const BLOCKS: Record<string, { agent: string; you: string; output: RegExp; tool: RegExp }> = {
  // A drawn table's corner is `└` too, followed by its rule.
  claude: { agent: "⏺", you: "❯", output: /^\s+⎿/, tool: /^[A-Z][\w -]*\(|^(?:Read|Reading|Ran|Running|Searched|Searching|Listed|Listing|Wrote|Writing|Updated|Updating|Fetched|Fetching|Edited|Called|Explored)\b.*\d/ },
  codex: { agent: "•", you: "›", output: /^\s+└ (?![─┴┬])/, tool: /^(?:Ran|Running|Explored|Exploring|Edited|Added|Deleted|Updated Plan|Searched|Called|Waited|Waiting|Working|Viewed|Read|Listed)\b/ },
};

/** Right-aligned status text (a version notice, a token count) sits far out; conversation is indented a few columns. */
const MAX_INDENT = 24;

/** The lines on Screen that Reader should have, top to bottom, reduced by `plain`. */
export function screenLines(screen: string, agent: string): string[] {
  const shape = BLOCKS[agent];
  if (!shape) return [];
  const rows = screen.split("\n");
  // The composer is the person's last `❯`/`›` row: what they are typing, not what was sent.
  let composer = -1;
  rows.forEach((row, index) => { if (row.startsWith(`${shape.you} `) || row === shape.you) composer = index; });
  // A block is a row at the left edge and everything indented under it. A
  // tool step has output under it (`⎿`, `└`); Codex titles its steps in words
  // ("• Inspect the branch"), so the output, not the title, says which it is.
  const lines: string[] = [];
  for (let start = 0; start < rows.length; start++) {
    const head = rows[start]!;
    if (!head.trim() || /^\s/.test(head)) continue;
    let end = start + 1;
    while (end < rows.length && (!rows[end]!.trim() || /^\s/.test(rows[end]!))) end++;
    const body = rows.slice(start + 1, end);
    const said = head.startsWith(`${shape.agent} `) ? head.slice(2) : head.startsWith(`${shape.you} `) && start !== composer ? head.slice(2) : null;
    const tool = said !== null && head.startsWith(shape.agent) && (shape.tool.test(said) || body.some(row => shape.output.test(row)));
    // A numbered row after the person's mark is a menu, answered on its card.
    const menu = said !== null && head.startsWith(shape.you) && /^\d+\./.test(said);
    if (said === null || tool || menu) { start = end - 1; continue; }
    lines.push(plain(said));
    // A parked job's view draws its collapsed steps ("Ran 3 shell commands")
    // indented inside the reply rather than after their own mark.
    for (const row of body) if (row.trim() && row.length - row.trimStart().length <= MAX_INDENT && !shape.tool.test(row.trimStart())) lines.push(plain(row));
    start = end - 1;
  }
  // Short lines ("Done.", a path, a number) match by accident as easily as by design.
  return lines.filter(line => line.split(" ").length >= 4 && line.length >= 20);
}

function blockText(block: LogBlock): string[] {
  switch (block.kind) {
    case "text":
    case "thinking":
      return [block.text];
    case "tool":
      return [block.name, block.summary, block.result?.text ?? "", ...(block.questions ?? []).flatMap(q => [q.text, ...q.options.flatMap(o => [o.label, o.description ?? ""])]),
        block.subagent?.description ?? "", ...(block.todos ?? []).map(t => t.content)];
    default:
      return [];
  }
}

/** Everything Reader would show for a page, as one `plain` string to search. */
export function readerText(log: Pick<SessionLog, "messages" | "tasks">): string {
  const parts = log.messages.flatMap(message => message.blocks.flatMap(blockText));
  for (const task of log.tasks ?? []) parts.push(task.subject, task.activeForm ?? "");
  return ` ${parts.map(plain).filter(Boolean).join(" ")} `;
}

export interface Parity {
  /** Screen lines compared, and how many Reader has. */
  lines: number;
  found: number;
  /** Of the lines nearest the composer (the newest), how many Reader lacks: a stale Reader shows here first. */
  newestMissing: number;
  /** Tasks Screen lists, and how many of them Reader's task list has. */
  tasks: number;
  tasksFound: number;
  /** Lines Reader lacks, newest last, for a person who asks to see them. */
  missing: string[];
}

export const NEWEST = 3;

export function compare(screen: string, agent: string, log: Pick<SessionLog, "messages" | "tasks">): Parity {
  const corpus = readerText(log);
  const lines = screenLines(screen, agent);
  const missing = lines.filter(line => !corpus.includes(line));
  const newest = lines.slice(-NEWEST);
  const tasks = agent === "claude" ? screenTasks(screen) : [];
  const listed = new Set((log.tasks ?? []).flatMap(task => [plain(task.subject), plain(task.activeForm ?? "")]));
  return {
    lines: lines.length,
    found: lines.length - missing.length,
    newestMissing: newest.filter(line => !corpus.includes(line)).length,
    tasks: tasks.length,
    // Screen truncates a long subject with "…"; Reader has it whole.
    tasksFound: tasks.filter(task => [...listed].some(subject => subject.startsWith(plain(task.subject.replace(/…$/, ""))))).length,
    missing,
  };
}

/** A verdict a person can act on, or null when Read agrees with Screen. */
export function disagreement(parity: Parity): string | null {
  if (parity.tasks && parity.tasksFound < parity.tasks) return `Screen lists ${parity.tasks} tasks, Read has ${parity.tasksFound} of them`;
  // Two of three, not one: a background report still waiting in Claude's
  // queue is drawn before Reader can have it (record:queue-operation), and it
  // is the newest line. A stale or wrong transcript misses all three.
  if (parity.lines && parity.newestMissing >= Math.min(2, parity.lines)) return `Read lacks ${parity.newestMissing} of the ${Math.min(NEWEST, parity.lines)} newest lines on Screen`;
  if (parity.lines >= 8 && parity.found / parity.lines < 0.8) return `Read has ${parity.found} of ${parity.lines} lines on Screen`;
  return null;
}
