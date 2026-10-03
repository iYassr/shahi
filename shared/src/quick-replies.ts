import type { AgentStatus } from "./index";

/**
 * One-tap replies for an agent waiting on the person's next message.
 *
 * Most replies to an agent that has stopped are a few words, and on a phone
 * those few words are the slow part. Four, worded as a person types them:
 * carry on after a stop, accept what it proposed in prose, ask again plainly,
 * and ask what was done — reading a diff on a phone is the thing a summary
 * saves. They are sent exactly as if typed and sent: the same request, the
 * same operation id, the same refusals.
 */
export const QUICK_REPLIES = ["Continue", "Yes, go ahead", "Explain that more simply", "Summarize what you changed"] as const;

/**
 * How long after a send the chips stay away while the agent still looks
 * idle. Between a receipt and the next status the agent reads as waiting, and
 * the chips came back under the finger that had just sent one. herdr reports
 * a prompted agent working within a second, which ends the wait sooner; a
 * command such as `/context` answers without working, and this ends it.
 */
export const REPLY_SETTLE_MS = 5_000;

export interface ReplyMoment {
  /** herdr lists the pane as an agent. A shell's next line is a command, not a reply. */
  isAgent: boolean;
  status: AgentStatus | undefined;
  /** A prompt card is open: the agent waits on a choice, and the card answers it. */
  prompt: boolean;
  /** The agent's status line says it is working, or a sent message still awaits its reply. */
  working: boolean;
  /** Something is typed or attached. A chip must never replace or discard it. */
  drafted: boolean;
  sending: boolean;
  /** The link is live and herdr is connected: a send could go now. */
  canWrite: boolean;
}

/**
 * Whether the agent waits for the person's next message: herdr says idle or
 * done, nothing on screen asks for a choice, nothing is under way, and the
 * composer is empty. Only then are the chips and the `/` shortcut offered.
 *
 * Hidden rather than inserted while a draft exists, because either other
 * choice loses something: sending ignores the typed words, and inserting
 * mixes a canned phrase into them. The draft is the person's; the chips come
 * back when it is empty.
 */
export function waitingForReply(m: ReplyMoment): boolean {
  return m.isAgent && (m.status === "idle" || m.status === "done") && !m.prompt && !m.working && !m.drafted && !m.sending && m.canWrite;
}
