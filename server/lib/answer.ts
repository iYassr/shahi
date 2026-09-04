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
 * the label it showed as well as the index, a fresh parse must agree on both,
 * and otherwise nothing is pressed: the phone is told the prompt is gone or
 * changed and shows what is actually on screen.
 */

import { parsePrompt, stripAnsi } from "./prompt-parser";
import type { ParsedPrompt, PromptOption } from "@shahi/shared";

/** The two herdr calls this module makes, typed loosely so a test can fake them. */
export type AnswerRpc = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/** What the phone tapped: the option as it was shown. */
export interface Choice {
  index: number;
  label: string;
}

/** The screen no longer shows a prompt at all. */
export class PromptGone extends Error {
  readonly code = "prompt_gone";
  constructor(paneId: string) {
    super(`${paneId} is not asking anything now`);
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
 */
export function keysFor(prompt: ParsedPrompt, target: PromptOption): string[] {
  if (prompt.answer === "digit") return [String(target.index), ...(prompt.confirm ? ["Enter"] : [])];
  const from = prompt.options.findIndex((o) => o.selected);
  const to = prompt.options.indexOf(target);
  const delta = to - from;
  const moves = Array.from({ length: Math.abs(delta) }, () => (delta > 0 ? "Down" : "Up"));
  return [...moves, "Enter"];
}

/** Reads the pane, checks the choice is still on offer, and presses the keys for it. */
export async function answerPrompt(rpc: AnswerRpc, paneId: string, choice: Choice): Promise<string[]> {
  // The same read the poller makes, so what is parsed here is what it parsed.
  const { read } = (await rpc("pane.read", {
    pane_id: paneId,
    source: "visible",
    format: "ansi",
    strip_ansi: false,
  })) as { read: { text: string } };

  const prompt = parsePrompt(stripAnsi(read.text));
  if (!prompt) throw new PromptGone(paneId);
  const target = prompt.options.find((o) => o.index === choice.index);
  if (!target || target.label !== choice.label) throw new PromptChanged(paneId);

  const keys = keysFor(prompt, target);
  await rpc("pane.send_keys", { pane_id: paneId, keys });
  return keys;
}
