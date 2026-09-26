import type { DashboardPane, ParsedPrompt } from "./index";

/**
 * Which question a card shows: what it asks, what it asked under, and what it
 * offers. Every Claude permission offers "1. Yes", so the options alone do
 * not tell one question from the next.
 */
export function promptIdentity(prompt: ParsedPrompt): string {
  return JSON.stringify([prompt.question, prompt.context ?? [], prompt.options.map((o) => [o.index, o.label])]);
}

/**
 * A question this client answered, or tried to, on a pane that has not yet
 * stopped waiting. `sent` landed; `closed` was refused because the screen had
 * already moved on, and nothing was pressed.
 */
export interface AnsweredPrompt {
  identity: string;
  outcome: "sent" | "closed";
}

export interface PromptState {
  /** What each waiting card offers, by pane. */
  prompts: Record<string, ParsedPrompt>;
  /** What each card has already answered, by pane. */
  answered: Record<string, AnsweredPrompt>;
}

/**
 * The prompts a dashboard offers after a session snapshot.
 *
 * The snapshot's own prompt is the server's current parse of the screen, and
 * it wins over anything remembered — null included. Both clients used to keep
 * a remembered prompt over it for as long as the pane stayed blocked, and the
 * server announces a new question only once, to whoever is connected: a phone
 * that slept through question B while its person answered A at the laptop
 * came back to A's options, whose every tap was refused with 409, until the
 * app was reloaded (pre-release bug hunt). A remembered prompt is still used
 * against a server whose snapshot carries none at all.
 *
 * An answered question is never offered again while the pane waits: the
 * snapshot that follows an answer often still carries it, and brought its
 * options back, live. It is forgotten when the pane stops waiting or asks
 * something else.
 */
export function promptsFromSession(
  panes: readonly Pick<DashboardPane, "paneId" | "status" | "prompt">[],
  current: PromptState,
): PromptState {
  const next: PromptState = { prompts: {}, answered: {} };
  for (const pane of panes) {
    if (pane.status !== "blocked") continue;
    const prompt = pane.prompt !== undefined ? pane.prompt : current.prompts[pane.paneId] ?? null;
    const answered = current.answered[pane.paneId];
    if (answered && (!prompt || promptIdentity(prompt) === answered.identity)) next.answered[pane.paneId] = answered;
    else if (prompt) next.prompts[pane.paneId] = prompt;
  }
  return next;
}

/**
 * A prompt pushed for one pane, by a `prompt` message or a watched pane's
 * frame. A frame with no prompt means the screen no longer shows one, and the
 * card stops offering it; a push of the question just answered is the screen
 * before the agent repainted, and changes nothing.
 */
export function promptPushed(current: PromptState, paneId: string, prompt: ParsedPrompt | null): PromptState {
  const prompts = { ...current.prompts };
  const answered = current.answered[paneId];
  if (!prompt) {
    if (!(paneId in prompts)) return current;
    delete prompts[paneId];
    return { prompts, answered: current.answered };
  }
  if (answered?.identity === promptIdentity(prompt)) return current;
  prompts[paneId] = prompt;
  const rest = { ...current.answered };
  delete rest[paneId];
  return { prompts, answered: rest };
}

/** The card for `paneId` answered `shown`, or found it already gone. */
export function promptAnswered(current: PromptState, paneId: string, shown: ParsedPrompt | undefined, outcome: AnsweredPrompt["outcome"]): PromptState {
  const prompts = { ...current.prompts };
  delete prompts[paneId];
  const identity = shown ? promptIdentity(shown) : "";
  return { prompts, answered: { ...current.answered, [paneId]: { identity, outcome } } };
}

/** Codes the answer route gives when the screen moved on and nothing was pressed. */
export function answerRefused(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "prompt_gone" || code === "prompt_changed";
}
