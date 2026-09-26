/**
 * Answering a parsed prompt — one call from the phone, decided here against
 * the screen as it is *now*.
 *
 * Two shapes of menu, and the phone cannot tell which keystrokes answer either:
 *
 *  - a numbered list (`❯ 1. Yes, proceed`) is answered by pressing its digit;
 *  - an unnumbered cursor menu — Claude Code's folder-trust question,
 *    `❯ No, exit` over `  Yes, I trust this folder` — is answered by moving the
 *    cursor and pressing Enter. Measured on a live pane (2026-09-02): a digit
 *    does nothing there, several keys in one `pane.send_keys` land in order,
 *    and the menu's default is "No, exit" — so the bare Enter the live suite
 *    used to send quit the agent it had just started.
 *
 * The screen is re-read rather than trusted from the phone's copy. The
 * poller's frame is up to 15s old for an unwatched pane, the cursor may have
 * moved since (a person at the keyboard, an earlier key from the phone), and a
 * move computed from a stale cursor selects the wrong row. So the phone sends
 * the label it showed as well as the index — and the question and context it
 * showed them under — a fresh parse must agree on all of them, and otherwise
 * nothing is pressed: the phone is told the prompt is gone or changed and
 * shows what is actually on screen.
 */

import { isTextField, parsePrompt, stripAnsi } from "./prompt-parser";
import { PromptInstances, screenId } from "./prompt-instances";
import type { ParsedPrompt, PromptOption } from "@shahi/shared";

/** The two herdr calls this module makes, typed loosely so a test can fake them. */
export type AnswerRpc = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/** What the phone tapped: the option as it was shown. */
export interface Choice {
  index: number;
  label: string;
  /**
   * The question and context the card showed the option under.
   *
   * Index and label alone cannot tell two permission menus apart: every
   * Claude Code permission offers "1. Yes", so a card still showing the
   * approval for `touch probe.txt` approved `rm -rf build dist` when that was
   * what the screen asked by the time the tap arrived (pre-release review).
   * A client from before this sends neither and is held to index and label,
   * as it always was.
   */
  question?: string;
  context?: string[];
  /** The appearance of the prompt the card was drawn from; see `ParsedPrompt.promptId`. */
  promptId?: string;
}

/**
 * The prompt the card showed is not on screen: there is none, it has been
 * answered already, or the one there now is a later appearance.
 */
export class PromptGone extends Error {
  readonly code = "prompt_gone";
  constructor(paneId: string, message = `${paneId} is not asking anything now`) {
    super(message);
  }
}

/** The screen shows a prompt, but not the option the phone tapped. */
export class PromptChanged extends Error {
  readonly code = "prompt_changed";
  constructor(paneId: string) {
    super(`the question in ${paneId} changed before the answer arrived`);
  }
}

/**
 * The keystrokes that pick `target` in `prompt`.
 *
 * A cursor menu is walked from where its cursor is, not from the top: Enter
 * confirms whatever row is lit, and the parser records which one that is.
 *
 * A digit menu whose lit row is a text field is left by `Up` first. Claude
 * Code's menu takes only arrows and Tab while a text field has the cursor, so
 * the digit alone was typed into the field: the tap reported success, nothing
 * was chosen, and the field's new text then made the composer refuse too
 * (pre-release bug hunt, B10). `Up` then the digit, in one send, chose the
 * right row from both an empty and a typed field (measured on 2.1.282). A tap
 * on the text field itself, when it already has the cursor, presses nothing:
 * the answer is what the person types next.
 */
export function keysFor(prompt: ParsedPrompt, target: PromptOption): string[] {
  if (prompt.answer === "digit") {
    const lit = prompt.options.find((o) => o.selected);
    const inField = lit !== undefined && isTextField(prompt, lit);
    if (inField && target === lit) return [];
    return [...(inField ? ["Up"] : []), String(target.index), ...(prompt.confirm ? ["Enter"] : [])];
  }
  const from = prompt.options.findIndex((o) => o.selected);
  const to = prompt.options.indexOf(target);
  const delta = to - from;
  const moves = Array.from({ length: Math.abs(delta) }, () => (delta > 0 ? "Down" : "Up"));
  return [...moves, "Enter"];
}

/** How long an answer holds its pane for the agent to draw what follows, and how often it looks. */
export const SETTLE_MS = 1_500;
const SETTLE_POLL_MS = 25;

export interface AnswerOptions {
  /** Every read of the pane, the poller's included, observed in one place. */
  instances?: PromptInstances;
  sleep?: (ms: number) => Promise<void>;
  settleMs?: number;
}

/**
 * Reads the pane, checks the choice is still on offer, and presses the keys for it.
 *
 * Then it waits, up to `SETTLE_MS`, for the screen to change, and the caller
 * holds the pane's write lock (`PaneWrites`) throughout. Two phones answering
 * one prompt within the agent's repaint time both read it still on screen
 * and both pressed "1"; the second approved the next prompt, which neither
 * had shown (pre-release bug hunt, B5: 29 of 40 trials against an agent that
 * repaints in 32ms). Queued behind the wait, the second re-reads what the
 * first left. A screen that has not changed by then is refused to every later
 * answer as already answered, until it does.
 */
export async function answerPrompt(
  rpc: AnswerRpc,
  paneId: string,
  choice: Choice,
  { instances = new PromptInstances(), sleep = (ms) => Bun.sleep(ms), settleMs = SETTLE_MS }: AnswerOptions = {},
): Promise<string[]> {
  const { prompt, screen, promptId } = await look(rpc, paneId, instances);
  if (!prompt) throw new PromptGone(paneId);
  if (instances.alreadyAnswered(paneId, screen)) {
    throw new PromptGone(paneId, "That question has already been answered. Wait for the agent to show what comes next.");
  }
  const target = prompt.options.find((o) => o.index === choice.index);
  if (!target || target.label !== choice.label) throw new PromptChanged(paneId);
  if (choice.question !== undefined && !sameQuestion(prompt, choice)) throw new PromptChanged(paneId);
  // Same content, another appearance: the card was drawn before an answer,
  // and this is the agent asking again.
  if (choice.promptId !== undefined && choice.promptId !== promptId) {
    throw new PromptGone(paneId, "The agent has asked this again since the card was drawn. Check the new question before answering.");
  }

  const keys = keysFor(prompt, target);
  if (keys.length === 0) return keys;
  await rpc("pane.send_keys", { pane_id: paneId, keys });
  // A text field's digit only puts the cursor in it: the question is still
  // open, waiting for what is typed there.
  if (isTextField(prompt, target)) return keys;

  instances.answered(paneId, screen);
  // Counted in polls rather than against the clock, so each wait is a poll
  // interval plus one read, and a test's sleep can stand in for it.
  for (let waited = 0; waited < settleMs; waited += SETTLE_POLL_MS) {
    await sleep(SETTLE_POLL_MS);
    const now = await look(rpc, paneId, instances).catch(() => null);
    if (!now || now.screen !== screen) break;
  }
  return keys;
}

/**
 * The same read the poller makes, so what is parsed here is what it parsed,
 * and observed like it. A read the poller overtook with a different screen
 * has no id to give, since the screen was changing under it; it is made again.
 */
async function look(rpc: AnswerRpc, paneId: string, instances: PromptInstances) {
  for (let attempt = 1; ; attempt++) {
    const ticket = instances.ticket(paneId);
    const { read } = (await rpc("pane.read", {
      pane_id: paneId,
      source: "visible",
      format: "ansi",
      strip_ansi: false,
    })) as { read: { text: string } };
    const screen = screenId(read.text);
    const prompt = parsePrompt(stripAnsi(read.text));
    const promptId = instances.observe(paneId, ticket, prompt, screen);
    if (!prompt || promptId !== undefined || attempt === LOOK_ATTEMPTS) return { prompt, screen, promptId };
  }
}
const LOOK_ATTEMPTS = 3;

/** Whether the screen still asks what the card showed; a prompt without context equals an empty one. */
function sameQuestion(prompt: ParsedPrompt, choice: Choice): boolean {
  const now = prompt.context ?? [];
  const shown = choice.context ?? [];
  return prompt.question === choice.question && now.length === shown.length && now.every((line, i) => line === shown[i]);
}
