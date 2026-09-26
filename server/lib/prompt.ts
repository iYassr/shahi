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
 * answer to single letters (`y`, `p`). So before any write to an agent, by
 * either path, the screen is read, and if it shows a menu the text is refused
 * with `prompt_open` — unless the lit row is one that takes typed text, where
 * the text replaces the row's label and Enter submits it (measured on the
 * same version; see `isTextField`). Found in the pre-release review; the
 * agent path was added to it in the pre-release bug hunt (B4).
 *
 * The caller runs this under the pane's write lock (`PaneWrites`), so no
 * other write from a phone lands between the read and the Enter.
 */

import { isTextField, parsePrompt, stripAnsi } from "./prompt-parser";

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

/**
 * The agent's screen changed between typing and Enter, so Enter was not
 * pressed. The text was typed, so this is a failure a retry must not repeat.
 */
export class PromptMoved extends Error {
  readonly code = "prompt_changed";
  constructor() {
    super(
      "The agent's screen changed while this message was being typed, so Enter was not pressed. " +
        "The text is typed there: check the screen, then press Enter from the keys if it is still right.",
    );
  }
}

export async function submitPrompt(
  rpc: PromptRpc,
  target: PromptTarget,
  text: string,
  sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
): Promise<PromptPath> {
  const { paneId } = target;
  if (!target.isAgent) {
    await rpc("pane.send_text", { pane_id: paneId, text });
    await sleep(SUBMIT_DELAY_MS);
    await rpc("pane.send_keys", { pane_id: paneId, keys: ["Enter"] });
    return "terminal";
  }

  // The screen is read before every write to an agent, whatever herdr says
  // its status is. herdr reports a new agent `unknown` for its first seconds
  // (about 3s after `agent.start` on 0.9.1, measured) with its folder-trust
  // menu already drawn, and `agent.prompt` accepted text then, typed it
  // and pressed Enter on the lit "No, exit", quitting the agent; on codex it
  // confirmed a trust nobody chose (pre-release bug hunt, B4). A menu on
  // screen means the agent is waiting on it, so it takes the terminal path,
  // and only into a text field.
  let menu = await openMenu(rpc, paneId);
  if (!menu && target.status !== "blocked") {
    try {
      await rpc("agent.prompt", { target: paneId, text });
      return "agent";
    } catch (err) {
      // The status can change between the mirror's last snapshot and now. If
      // herdr says the agent is blocked, it is, and the terminal path is what
      // would have been chosen with fresher information.
      if (!(err instanceof Error && err.message.includes("agent_blocked"))) throw err;
    }
    menu = await openMenu(rpc, paneId);
  }
  await rpc("pane.send_text", { pane_id: paneId, text });
  await sleep(SUBMIT_DELAY_MS);
  // Read again before Enter. Other phones' writes wait their turn, but a
  // person at the terminal does not, and in these 200ms a moved cursor or a
  // newly drawn menu turns Enter into a choice nobody made (pre-release bug
  // hunt, B6). Labels are no test, since the typed text has just replaced the
  // field's; the same question with the cursor on the same row is.
  if (!sameSpot(menu, await openMenu(rpc, paneId, { refuse: false }))) throw new PromptMoved();
  await rpc("pane.send_keys", { pane_id: paneId, keys: ["Enter"] });
  return "terminal";
}

/** Where a menu's cursor is: the question, and the lit row's number. */
interface Spot {
  question: string;
  row: number;
}

function sameSpot(before: Spot | null, after: Spot | null): boolean {
  if (!before || !after) return before === after;
  return before.question === after.question && before.row === after.row;
}

/**
 * The menu on the pane's screen, when there is one. A menu whose lit row
 * would not take typed text is refused with `PromptOpen`, unless `refuse` is
 * false, when it is returned like any other.
 */
async function openMenu(rpc: PromptRpc, paneId: string, { refuse = true } = {}): Promise<Spot | null> {
  // The same read the poller and `answer.ts` make, so the menu found here is
  // the one the phone was offered buttons for.
  const { read } = (await rpc("pane.read", {
    pane_id: paneId,
    source: "visible",
    format: "ansi",
    strip_ansi: false,
  })) as { read: { text: string } };
  const menu = parsePrompt(stripAnsi(read.text));
  if (!menu) return null;
  const lit = menu.options.find((option) => option.selected);
  if (refuse && (!lit || !isTextField(menu, lit))) throw new PromptOpen();
  return { question: menu.question, row: lit?.index ?? 0 };
}

/**
 * What the pane is, asked of herdr now rather than of the mirror.
 *
 * The mirror is re-snapshotted every 3s, and a just-started agent was still a
 * shell in it: the text went down the terminal path with no screen read at
 * all, onto the folder-trust menu (pre-release bug hunt, B4). herdr's own
 * `pane.get` knows it launched an agent there. Either opinion that the pane
 * holds an agent is taken, because the agent path is the careful one: it
 * reads the screen, and `agent.prompt` refuses a pane with no agent rather
 * than typing into its shell. The mirror stands in when herdr cannot answer.
 */
export async function promptTarget(
  rpc: PromptRpc,
  paneId: string,
  mirrored: { agent_status?: string | null } | undefined,
): Promise<PromptTarget> {
  const fallback = { paneId, isAgent: mirrored !== undefined, status: mirrored?.agent_status ?? null };
  try {
    const { pane } = (await rpc("pane.get", { pane_id: paneId })) as {
      pane?: { agent?: string | null; agent_status?: string | null };
    };
    if (!pane) return fallback;
    const fresh = Boolean(pane.agent);
    return {
      paneId,
      isAgent: fresh || fallback.isAgent,
      status: fresh ? pane.agent_status ?? null : fallback.status,
    };
  } catch {
    return fallback;
  }
}
