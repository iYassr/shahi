/**
 * Submitting a conversational prompt to a pane — one call from the phone.
 *
 * Two paths, chosen here rather than on the phone so the phone never learns a
 * herdr method name:
 *
 *  - **An agent pane** gets `agent.prompt`, herdr's own semantic submit. herdr
 *    knows how each agent's composer wants text delivered and submitted, so
 *    this replaces the old text → 200ms → Enter sequence and its two round
 *    trips with one operation.
 *  - **Anything else** — a shell, an unknown program, and an agent that is
 *    *blocked* — gets the terminal sequence: `pane.send_text`, a pause, then
 *    Enter. The pause is required, not defensive: codex's composer needs a
 *    moment to ingest inserted text before Enter counts as submit (measured:
 *    150ms sufficed, 200ms is the margin). Blocked agents take this path
 *    because `agent.prompt` refuses them — "If the agent is already blocked,
 *    submission is rejected with agent_blocked before any input is sent"
 *    (herdr 0.8.2) — and typing an answer into a waiting agent is exactly what
 *    the composer is for when the prompt parser has nothing better to offer.
 *
 * `wait` is deliberately never supplied: the phone wants a receipt, and the
 * reply arrives through the transcript.
 *
 * Typing at a blocked agent is only safe when what it is blocked on takes
 * text. A menu does not: the letters are ignored, or move the cursor, and the
 * Enter confirms whichever row is lit. Measured on Claude Code 2.1.280's Bash
 * permission menu, cursor on "1. Yes": typing "no" then Enter ran the command.
 * The folder-trust menu's lit row quits the agent, and codex's approval rows
 * answer to single letters (`y`, `p`). So before typing at an agent, the
 * screen is read, and if it shows a menu the text is refused with
 * `prompt_open` — unless the lit row is one that takes typed text, where the
 * text replaces the row's label and Enter submits it (measured on the same
 * version for both rows in `FREE_TEXT_ROWS`). Found in the pre-release review.
 */

import { parsePrompt, stripAnsi } from "./prompt-parser";

/** The herdr calls this module is allowed to make, typed loosely so a test can fake them. */
export type PromptRpc = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/** A menu is open on the agent's screen, and typed text would answer it with its lit row. */
export class PromptOpen extends Error {
  readonly code = "prompt_open";
  constructor() {
    super(
      "This agent is waiting on a choice. Answer it with the option buttons or the keys; " +
        "a message sent now would press Enter on the highlighted option.",
    );
  }
}

/**
 * Menu rows that are text fields while the cursor is on them: Claude Code's
 * question tool ("Type something.") and plan approval ("Tell Claude what to
 * change"). Not "No, and tell Claude what to do differently": typing there
 * does nothing, and Enter answers No without the text.
 */
const FREE_TEXT_ROWS = new Set(["Type something.", "Tell Claude what to change"]);

export interface PromptTarget {
  paneId: string;
  /** True when herdr lists this pane as an agent. */
  isAgent: boolean;
  /** herdr's `agent_status`, when it is an agent. */
  status: string | null;
}

/** See `api.send` in the old client. Measured against a live codex pane: 150ms sufficed. */
export const SUBMIT_DELAY_MS = 200;

export type PromptPath = "agent" | "terminal";

export async function submitPrompt(
  rpc: PromptRpc,
  target: PromptTarget,
  text: string,
  sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
): Promise<PromptPath> {
  if (target.isAgent && target.status !== "blocked") {
    try {
      await rpc("agent.prompt", { target: target.paneId, text });
      return "agent";
    } catch (err) {
      // The status can change between the mirror's last snapshot and now. If
      // herdr says the agent is blocked, it is, and the terminal path is what
      // would have been chosen with fresher information.
      if (!(err instanceof Error && err.message.includes("agent_blocked"))) throw err;
    }
  }
  if (target.isAgent && (await menuWithoutTextField(rpc, target.paneId))) throw new PromptOpen();
  await rpc("pane.send_text", { pane_id: target.paneId, text });
  await sleep(SUBMIT_DELAY_MS);
  await rpc("pane.send_keys", { pane_id: target.paneId, keys: ["Enter"] });
  return "terminal";
}

/** True when the pane shows a menu whose lit row would not take typed text. */
async function menuWithoutTextField(rpc: PromptRpc, paneId: string): Promise<boolean> {
  // The same read the poller and `answer.ts` make, so the menu found here is
  // the one the phone was offered buttons for.
  const { read } = (await rpc("pane.read", {
    pane_id: paneId,
    source: "visible",
    format: "ansi",
    strip_ansi: false,
  })) as { read: { text: string } };
  const menu = parsePrompt(stripAnsi(read.text));
  if (!menu) return false;
  const lit = menu.options.find((option) => option.selected);
  return !lit || !FREE_TEXT_ROWS.has(lit.label);
}
