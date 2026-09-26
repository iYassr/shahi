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
 * One menu has no numbers at all — Claude Code's folder-trust question:
 *
 *       No, exit
 *     ❯ Yes, I trust this folder
 *
 *     Enter to confirm · Esc to cancel
 *
 * It is the first thing a new agent asks, its default quits the agent, and
 * for months the phone showed "Nothing to read yet" over it. Digits do
 * nothing there (measured), so it is answered by moving the cursor; `answer`
 * on the result says which kind of menu the caller is looking at, and the
 * confirm hint under it is what makes it a menu rather than prose.
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

/** A row of an unnumbered menu: an optional cursor, then the label. */
const CURSOR_ROW_RE = /^(?<indent>\s*)(?<marker>[❯›>»▶]\s+)?(?<label>\S.*)$/u;

/** The line Claude Code prints under a cursor menu; a numbered prompt has no such line. */
const CONFIRM_HINT_RE = /\bEnter to confirm\b/;
/** Codex's numbered folder-trust menu selects a row, then waits for Enter. */
const DIGIT_CONFIRM_HINT_RE = /\bPress enter to continue\b/i;

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

import type { ParsedPrompt, PromptOption } from "@shahi/shared";

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

  const run = findOptionRun(lines) ?? findCursorMenu(lines);
  if (!run) return null;

  const question = findQuestion(lines, run.startLine);
  if (!question) return null;

  const prompt: ParsedPrompt = {
    question: question.text,
    answer: run.answer,
    options: run.options,
    ...(run.answer === "digit" && lines.slice(run.startLine).some((line) => DIGIT_CONFIRM_HINT_RE.test(line))
      ? { confirm: true }
      : {}),
    ...(question.context.length > 0 ? { context: question.context } : {}),
  };
  for (const option of prompt.options) if (isTextField(prompt, option)) option.textInput = true;
  return prompt;
}

interface OptionRun {
  answer: ParsedPrompt["answer"];
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
      answer: "digit",
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
 * Finds an unnumbered cursor menu: rows sharing a label column, exactly one
 * of them lit, with "Enter to confirm" printed beneath.
 *
 * The hint is the anchor, not the glyph. On the very screen this was written
 * for, the shell's echo of the `claude` command sits two `❯` lines above the
 * menu, and Claude Code's composer is a `❯` on its own — so rows are only
 * collected directly above a confirm hint, and only while their labels line
 * up. A blank line, a row whose label starts elsewhere, or anything that is
 * not a row ends the block; fewer than two rows, or any number of cursors
 * but one, is not a menu.
 */
function findCursorMenu(lines: string[]): OptionRun | null {
  let hint = -1;
  for (let n = lines.length - 1; n >= 0; n--) {
    if (CONFIRM_HINT_RE.test(lines[n]!)) {
      hint = n;
      break;
    }
  }
  if (hint < 0) return null;

  let i = hint - 1;
  while (i >= 0 && lines[i]!.trim() === "") i--;

  const rows: { label: string; selected: boolean }[] = [];
  let column: number | null = null;
  for (; i >= 0; i--) {
    const match = lines[i]!.match(CURSOR_ROW_RE);
    if (!match?.groups) break;
    const { indent, marker, label } = match.groups as { indent: string; marker?: string; label: string };
    const at = indent.length + (marker?.length ?? 0);
    if (column === null) column = at;
    else if (at !== column) break;
    rows.unshift({ label: label.trim(), selected: Boolean(marker) });
  }
  if (rows.length < 2) return null;
  if (rows.filter((r) => r.selected).length !== 1) return null;

  return {
    answer: "cursor",
    // Numbered in display order so a tap names a row the same way it does in
    // a numbered menu; the digit is never pressed for one of these.
    options: rows.map((row, n) => ({ index: n + 1, label: row.label, selected: row.selected })),
    startLine: i + 1,
  };
}

/**
 * Walks up from the option block to recover the question text.
 *
 * Blank lines and chrome (separator rules, box borders) are skipped; the
 * contiguous prose block above them is the question, joined back together
 * because Claude Code hard-wraps it at the pane width.
 */
function findQuestion(
  lines: string[],
  optionStart: number,
): { text: string; context: string[] } | null {
  let i = optionStart - 1;
  while (i >= 0 && (lines[i]!.trim() === "" || CHROME_ONLY_RE.test(lines[i]!))) i--;
  if (i < 0) return null;

  /*
   * Walk up collecting paragraphs, and take the first one that reads as a
   * question.
   *
   * The nearest block above the options is not always the question. codex puts
   * the command it wants to run there, with the question three paragraphs
   * further up — so taking the nearest gave a card headed by eight wrapped
   * lines of shell with the answers pushed off screen. Everything between the
   * question and the options is kept as context, which is where a command and
   * its reason belong.
   */
  /** Each paragraph's lines, and the index in `lines` of its top one. */
  const paragraphs: { text: string[]; top: number }[] = [];
  let current: string[] = [];

  while (i >= 0 && paragraphs.length < MAX_PARAGRAPHS) {
    const line = lines[i]!;

    if (line.trim() === "" || CHROME_ONLY_RE.test(line) || MARKER_LINE_RE.test(line)) {
      if (current.length > 0) {
        paragraphs.push({ text: current, top: i + 1 });
        current = [];
      }
      // A marker line is structure, and nothing above it belongs to this
      // prompt — codex prefixes a standalone `> You are in /tmp` above its
      // trust prompt.
      if (MARKER_LINE_RE.test(line)) break;
      i--;
      continue;
    }

    current.unshift(line.trim());
    i--;
    if (current.length >= MAX_PARAGRAPH_LINES) {
      paragraphs.push({ text: current, top: i + 1 });
      current = [];
    }
  }
  if (current.length > 0) paragraphs.push({ text: current, top: i + 1 });
  if (paragraphs.length === 0) return null;

  const joined = paragraphs.map((p) => p.text.join(" ").replace(/\s+/g, " ").trim());

  /*
   * A labelled line is context however it is punctuated.
   *
   * codex writes `Reason: May I inspect the failing tests?` — a question mark,
   * but not the question being asked. The question is the one line without a
   * label in front of it.
   */
  // A paragraph ending in "?" is the question. Failing that, one with a "?"
  // inside it: the folder-trust question asks and then keeps talking ("Is
  // this a project you created or one you trust? (Like your own code…). If
  // not, take a moment…"), and the paragraph nearest its options is the
  // "Security guide" link. Failing both, the nearest block is the best
  // guess, as before.
  const ended = joined.findIndex((p) => p.endsWith("?") && !LABELLED_RE.test(p));
  const asked = ended >= 0 ? ended : joined.findIndex((p) => p.includes("?"));
  if (asked < 0) return { text: joined[0] ?? "", context: [] };

  /*
   * Claude Code lays a permission out the other way round from codex: the
   * tool, then what it wants to do, then a generic "Do you want to proceed?"
   * directly above the options. Captured from Claude Code 2.1.280:
   *
   *     ─────────────────────────────────────
   *      Bash command
   *
   *        rm -rf build dist
   *        Delete build and dist directories
   *
   *      Do you want to proceed?
   *      ❯ 1. Yes
   *
   * Taking only what sits between question and options left every Bash,
   * WebFetch and MCP card as that bare question — approvable from the agents
   * list without ever seeing the command (pre-release review). So when nothing
   * sits between them, the dialog's own block above the question is the
   * context: from the question up to the rule Claude draws as the dialog's top
   * border, and nothing past it.
   *
   * The folder-trust question needs the same, and is found by the fallback
   * because it ends "…first." rather than "?". Its block above is
   * "Accessing workspace:" and the folder itself, and without it the card
   * offered "Yes, I trust this folder" without saying which folder
   * (pre-release bug hunt, B86). Placed first, since it sits above whatever
   * lies between the question and the options.
   */
  const context = joined.slice(0, asked).reverse();
  if (ended <= 0) context.unshift(...dialogAbove(lines, paragraphs[asked]!.top));

  return {
    // Nearest-first while walking up, so everything before the question in that
    // list sits between it and the options on screen.
    text: joined[asked]!,
    context,
  };
}

/**
 * The paragraphs between a dialog's top rule and the question at `top`, in
 * screen order.
 *
 * Only a block with a rule above it on screen counts: without one there is no
 * telling where the dialog ends and the conversation above it begins, and a
 * command shown without its start is worse than none — so an unbounded block,
 * or one that reaches a prompt marker first, gives nothing.
 *
 * Lines keep their breaks, unlike the rest of the context. The command and
 * its description are separate lines of one paragraph, and joining them with
 * a space made the description read as more of the command. Relative
 * indentation survives too, because a multi-line command's indentation can
 * be part of what it does.
 */
function dialogAbove(lines: string[], top: number): string[] {
  const blocks: string[][] = [];
  let current: string[] = [];
  const close = () => {
    if (current.length > 0) blocks.unshift(current);
    current = [];
  };
  for (let n = top - 1; n >= 0; n--) {
    const line = lines[n]!;
    if (line.trim() === "") {
      close();
      continue;
    }
    if (DIALOG_RULE_RE.test(line)) {
      close();
      return blocks.map(dedent);
    }
    if (MARKER_LINE_RE.test(line)) return [];
    current.unshift(line);
  }
  return [];
}

/**
 * The rule across the top of a Claude Code dialog: the full pane width of
 * `─`. Deliberately not any chrome-only line — a command's own `---` (a heredoc
 * writing YAML, say) would otherwise end the block halfway through the
 * command and show its tail as if it were all of it.
 */
const DIALOG_RULE_RE = /^\s*[─━═]{20,}\s*$/u;

/** Joins a paragraph's lines, less the indentation they all share. */
function dedent(block: string[]): string {
  const indent = Math.min(...block.map((line) => line.length - line.trimStart().length));
  return block.map((line) => line.slice(indent)).join("\n");
}

/**
 * Whether `option` is a text field: a row where typed text replaces the
 * label, and where Claude Code's menu takes only arrows and Tab while the
 * cursor is on it — a digit pressed there is typed into it, and answers
 * nothing (measured on 2.1.282: "❯ 3. Type something." became "❯ 3. 1").
 *
 * Untyped, the rows read "Type something." (the question tool) and "Tell
 * Claude what to change" (plan approval). Typed, the label is whatever was
 * typed, so the row is known by where it is instead: the question tool's is
 * the one directly above "Chat about this", and plan approval's carries the
 * "shift+tab to approve with this feedback" line under it. Not "No, and tell
 * Claude what to do differently": typing there does nothing.
 */
export function isTextField(prompt: ParsedPrompt, option: PromptOption): boolean {
  if (TEXT_FIELD_LABELS.has(option.label) || option.detail === PLAN_FEEDBACK_DETAIL) return true;
  const n = prompt.options.indexOf(option);
  return n >= 0 && n === prompt.options.length - 2 && prompt.options.at(-1)!.label === "Chat about this";
}

const TEXT_FIELD_LABELS = new Set(["Type something.", "Tell Claude what to change"]);
const PLAN_FEEDBACK_DETAIL = "shift+tab to approve with this feedback";

/** `Reason:`, `Environment:` — codex's own labels for the context it supplies. */
const LABELLED_RE = /^[A-Z][A-Za-z ]{1,20}:\s/;

/** Enough for a question, a reason and a command; not a whole message. */
const MAX_PARAGRAPHS = 5;
const MAX_PARAGRAPH_LINES = 8;
