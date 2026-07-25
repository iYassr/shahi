/**
 * Extracts an actionable prompt from a blocked agent's visible screen.
 *
 * When a Claude Code agent blocks, it renders a question followed by a numbered
 * option list, with `❯` marking the current selection:
 *
 *     Claude has written up a plan and is ready to execute. Would you like to proceed?
 *
 *     ❯ 1. Yes, and bypass permissions
 *       2. Yes, manually approve edits
 *       3. No, refine with Ultraplan on Claude Code on the web
 *       4. Tell Claude what to change
 *          shift+tab to approve with this feedback
 *
 * That structure is what makes one-tap approval possible on a phone.
 *
 * The same agent's question tool renders the list less tidily — an indented
 * explanation under each choice, and a separator rule partway down:
 *
 *     Which colour do you prefer?
 *
 *     ❯ 1. Red
 *          Warm, high-contrast — reads as alert or emphasis.
 *       2. Green
 *          Cool-warm midpoint — reads as success or growth.
 *       4. Type something.
 *     ──────────────────────────────────────────────────────
 *       5. Chat about this
 *
 * So the run tolerates both, and keeps the explanations: they are frequently
 * what the choice means, and a phone that dropped them would show less than the
 * terminal it is standing in for.
 *
 * The `❯` glyph on its own is *not* a reliable signal — it also appears as
 * herdr's pane marker and as Claude Code's slash-command echo (`❯ /model`) in
 * panes that are perfectly idle. Only a well-formed numbered run counts, and
 * even then the caller should be acting on herdr's own `agent_status` too.
 *
 * Anything this cannot parse returns `null`, and the UI falls back to the raw
 * terminal plus a free-text composer. A parser miss is an inconvenience, not a
 * breakage — keep it that way.
 */

/**
 * Matches `❯ 1. Label`, `› 2. Label`, `> 3. Label`, or a plain `  4. Label`.
 *
 * The cursor glyph is agent-specific: Claude Code draws `❯` (U+276F), codex
 * draws `›` (U+203A). Both must be here or the same prompt is actionable in one
 * agent and invisible in the other.
 */
const OPTION_RE = /^(?<indent>\s*)(?<marker>[❯›>»▶]\s*)?(?<index>\d{1,2})\.\s+(?<label>\S.*)$/u;

/** A line opening with a selection or prompt marker, rather than prose. */
const MARKER_LINE_RE = /^\s*[❯›>»▶]\s/u;

/** Box-drawing, block, and arrow glyphs Claude Code and herdr use for chrome. */
const CHROME_ONLY_RE = /^[\s─-╿▀-▟←-⇿■-◿·—–-]*$/u;

/**
 * Escape sequences, for callers holding raw `format: "ansi"` text.
 *
 * Written with explicit `\\x` escapes rather than literal control bytes so the
 * pattern stays reviewable — an invisible byte in a regex is exactly how the
 * OSC branch came to silently match nothing the first time around.
 */
const ANSI_RE = new RegExp(
  [
    // OSC: ESC ] ... terminated by BEL or ST. Claude Code sets the window title
    // this way, and the payload carries `;` and text that must not survive.
    "\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)",
    // CSI: ESC [ params intermediates final — SGR colour, cursor moves, erases.
    // 0x9b is the single-byte CSI some emitters use instead of ESC [.
    "(?:\\x1b\\[|\\x9b)[0-9;?]*[ -/]*[@-~]",
    // Remaining two-byte escapes (charset selection, ESC M, ...).
    "\\x1b[@-Z\\\\-_]",
  ].join("|"),
  "g",
);

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

import type { ParsedPrompt, PromptOption } from "@herdrui/shared";

export type { ParsedPrompt, PromptOption };

export interface ParseOptions {
  /**
   * How far up from the bottom of the screen to look. Prompts always render at
   * the bottom; scanning the whole scrollback invites false positives from
   * numbered lists inside an agent's own prose.
   */
  scanLines?: number;
}

/**
 * Parses the visible screen of a pane. Returns `null` when there is no
 * well-formed prompt to act on.
 *
 * Accepts either stripped or raw-ANSI text.
 */
export function parsePrompt(screen: string, options: ParseOptions = {}): ParsedPrompt | null {
  const scanLines = options.scanLines ?? 25;

  const allLines = stripAnsi(screen).split("\n").map((l) => l.trimEnd());
  const start = Math.max(0, allLines.length - scanLines);
  const lines = allLines.slice(start);

  const run = findOptionRun(lines);
  if (!run) return null;

  const question = findQuestion(lines, run.startLine);
  if (!question) return null;

  return { question, options: run.options };
}

interface OptionRun {
  options: PromptOption[];
  /** Index within `lines` of the first option line, for finding the question. */
  startLine: number;
}

/**
 * Finds the last run of consecutive options numbered 1..n.
 *
 * Requiring the run to start at 1 and increment by one is what rejects stray
 * numbered prose (an agent writing "3. Deploy" mid-answer) and ordered lists
 * that scrolled partly off screen.
 */
function findOptionRun(lines: string[]): OptionRun | null {
  let candidate: OptionRun | null = null;
  let current: {
    entries: { index: number; label: string; selected: boolean; indent: number; detail?: string }[];
    startLine: number;
  } | null = null;


  const flush = () => {
    if (!current) return;
    const { entries, startLine } = current;
    current = null;

    // Need a real choice, starting at 1 and increasing.
    //
    // Strictly 1..n was the earlier rule, and it was too strict: the question
    // tool's own list runs 1, 2, 3, 4, 5 in the simple case but can skip a
    // number, and answering by digit works regardless. Increasing-from-1 still
    // rejects the thing that rule existed for — an agent numbering points in
    // its prose, which never starts at 1 and climbs in a single screen-bottom
    // block with exactly one cursor on it.
    if (entries.length < 2) return;
    if (entries[0]!.index !== 1) return;
    if (entries.some((e, i) => i > 0 && e.index <= entries[i - 1]!.index)) return;

    // Exactly one option must carry the selection cursor.
    //
    // This is what separates an interactive select from an agent simply writing
    // a numbered list in its answer ("1. Enter your phone number / 2. Review
    // and tick the box / 3. Enter your card details"), which is common enough
    // that a live sweep of the session turned one up immediately. A rendered
    // select always has its cursor on exactly one row; prose never does.
    //
    // The trade-off is deliberate: if the cursor row is ever scrolled out of
    // view we return null and the UI falls back to the raw terminal, which is a
    // far better failure than offering answer buttons for a question nobody
    // asked and injecting a stray keystroke into a live session.
    if (entries.filter((e) => e.selected).length !== 1) return;

    candidate = {
      options: entries.map(({ index, label, selected, detail }) => ({
        index,
        label,
        selected,
        ...(detail ? { detail } : {}),
      })),
      startLine,
    };
  };

  for (const [i, line] of lines.entries()) {
    const match = line.match(OPTION_RE);
    if (!match?.groups) {
      // Three kinds of line do not end a run: blank ones, chrome (the separator
      // rule the question tool draws between choices), and a line indented past
      // the option it follows, which is that option's own explanation.
      if (line.trim() === "" || CHROME_ONLY_RE.test(line)) continue;

      const last = current?.entries.at(-1);
      const indent = line.length - line.trimStart().length;
      if (last && indent > last.indent) {
        last.detail = last.detail ? `${last.detail} ${line.trim()}` : line.trim();
        continue;
      }

      flush();
      continue;
    }

    const entry = {
      index: Number(match.groups.index),
      label: match.groups.label!.trim(),
      selected: Boolean(match.groups.marker),
      indent: match.groups.indent!.length,
      detail: undefined as string | undefined,
    };

    // A fresh "1." starts a new run rather than extending the previous one.
    if (!current || entry.index === 1) {
      flush();
      current = { entries: [entry], startLine: i };
    } else {
      current.entries.push(entry);
    }
  }
  flush();

  return candidate;
}

/**
 * Walks up from the option block to recover the question text.
 *
 * Blank lines and chrome (separator rules, box borders) are skipped; the
 * contiguous prose block above them is the question, joined back together
 * because Claude Code hard-wraps it at the pane width.
 */
function findQuestion(lines: string[], optionStart: number): string | null {
  let i = optionStart - 1;
  while (i >= 0 && (lines[i]!.trim() === "" || CHROME_ONLY_RE.test(lines[i]!))) i--;
  if (i < 0) return null;

  const collected: string[] = [];
  while (i >= 0) {
    const line = lines[i]!;
    if (line.trim() === "" || CHROME_ONLY_RE.test(line)) break;
    // A line that opens with a marker glyph is structure, not prose — codex
    // prefixes a standalone `> You are in /tmp` above its trust prompt, and
    // absorbing it into the question reads as one run-on sentence.
    if (MARKER_LINE_RE.test(line)) break;
    collected.unshift(line.trim());
    i--;
    // Questions are short. Stop before swallowing an agent's whole last message.
    if (collected.length >= 4) break;
  }

  const question = collected.join(" ").replace(/\s+/g, " ").trim();
  return question.length > 0 ? question : null;
}

