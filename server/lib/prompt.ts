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
 * answer to single letters (`y`, `p`). So before any write, by either path,
 * the screen is read, and if it shows a menu the text is refused with
 * `prompt_open` — unless the lit row is one that takes typed text, where the
 * text replaces the row's label and Enter submits it (measured on the same
 * version; see `isTextField`). A shell at its own prompt is the exception: it
 * reads the keys itself, and a menu on its screen is output left behind.
 * Found in the pre-release review; the agent path was added to it in the
 * pre-release bug hunt (B4), and panes herdr has not yet named an agent in
 * that bug's re-verification.
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
  /**
   * True when the pane's own shell alone has the terminal: the foreground
   * process group is the shell's and holds nothing else. Only then is a menu
   * on screen out of the keys' reach. Never true for an agent.
   */
  shellAlone: boolean;
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
  // A shell at its prompt reads the keys itself, so a menu on its screen is
  // output an earlier program left there, and the text is the person's to
  // send. Its Enter waits on the same question asked again: a program the
  // shell started as this message arrived, from the desk or from the message
  // ahead of it, has the terminal within 50ms, too late for `promptTarget` to
  // see, and Claude Code then draws its trust menu inside these 200ms (4
  // times in 4, measured on 2.1.283), where Enter chooses "No, exit".
  if (target.shellAlone) {
    await rpc("pane.send_text", { pane_id: paneId, text });
    await sleep(SUBMIT_DELAY_MS);
    if (!(await shellAlone(rpc, paneId))) throw new PromptMoved();
    await rpc("pane.send_keys", { pane_id: paneId, keys: ["Enter"] });
    return "terminal";
  }

  // Anything else has its screen read before any write, whatever herdr says
  // the pane is. herdr reports a new agent `unknown` for its first seconds
  // (about 3s after `agent.start` on 0.9.1, measured) with its folder-trust
  // menu already drawn, and `agent.prompt` accepted text then, typed it and
  // pressed Enter on the lit "No, exit", quitting the agent; on codex it
  // confirmed a trust nobody chose (pre-release bug hunt, B4). Earlier still,
  // for 215–285ms after the menu is drawn, herdr names no agent in the pane
  // at all (measured 16 times on 0.9.1), and the text went in as if to a
  // shell with no read: Claude Code quit 6 times in 6. A menu on screen means
  // the program holding the terminal is waiting on it, so it takes the
  // terminal path, and only into a text field.
  let menu = await openMenu(rpc, paneId);
  if (target.isAgent && !menu && target.status !== "blocked") {
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
  // field's; the same question with the cursor on the same row is. A program
  // just started draws its first menu after it has the terminal, so this read
  // is also what catches a menu drawn over text typed before it: sent the
  // moment Claude Code had the terminal, 4 messages in 4 were stopped here
  // with its trust menu up (B4, re-verified).
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
 *
 * `pane.get` lags too, by less: it names the agent 215–285ms after the agent
 * has drawn its trust menu (measured 16 times on 0.9.1). So a pane neither
 * calls an agent is asked who has its terminal, which herdr answers from the
 * terminal itself and without that lag.
 */
export async function promptTarget(
  rpc: PromptRpc,
  paneId: string,
  mirrored: { agent_status?: string | null } | undefined,
): Promise<PromptTarget> {
  let isAgent = mirrored !== undefined;
  let status = mirrored?.agent_status ?? null;
  try {
    const { pane } = (await rpc("pane.get", { pane_id: paneId })) as {
      pane?: { agent?: string | null; agent_status?: string | null };
    };
    if (pane?.agent) {
      isAgent = true;
      status = pane.agent_status ?? null;
    }
  } catch {
    // The mirror answers when herdr cannot.
  }
  if (isAgent) return { paneId, isAgent, status, shellAlone: false };
  return { paneId, isAgent, status: null, shellAlone: await shellAlone(rpc, paneId) };
}

/**
 * Whether the pane's shell alone has its terminal.
 *
 * Measured on herdr 0.9.1 (macOS, zsh): at the prompt the foreground process
 * group is the shell's pid and holds only the shell. 20ms after Enter the
 * group still is the shell's but holds a forked child as well, and from 50ms
 * the program has a group of its own. Anything herdr cannot answer counts as
 * not alone, so the screen decides.
 */
async function shellAlone(rpc: PromptRpc, paneId: string): Promise<boolean> {
  try {
    const { process_info: info } = (await rpc("pane.process_info", { pane_id: paneId })) as {
      process_info?: {
        shell_pid?: number | null;
        foreground_process_group_id?: number | null;
        foreground_processes?: { pid: number }[];
      };
    };
    const shell = info?.shell_pid;
    if (!shell || info.foreground_process_group_id !== shell) return false;
    return (info.foreground_processes ?? []).every((process) => process.pid === shell);
  } catch {
    return false;
  }
}
