/**
 * Which appearance of a prompt a screen shows, per pane.
 *
 * A prompt's content does not identify it. An agent asking for
 * `touch probe.txt` a second time draws the same question, context and
 * options, so a card left on one phone from the first time approved the
 * second, which that phone never showed (pre-release bug hunt, B46). And
 * two phones answering one prompt both succeeded when the second read the
 * screen before the agent had repainted, so the second key press approved
 * the prompt after it (B5).
 *
 * So every read of a pane is observed here, and each appearance gets an id:
 * a new one when a prompt is seen after a screen without one, when its
 * question or options change, and once it has been answered. The answered
 * screen itself is remembered until the pane shows anything else, and a
 * second answer against it is refused: what it asks has already been
 * answered, whatever the agent has yet to draw.
 *
 * The poller and the answer route both read the pane, and a slow read can
 * finish after a faster, later one. Each read takes a ticket before it is
 * sent, and one that finishes behind a later ticket changes nothing, so a
 * stale screen cannot revive a prompt that a newer read saw gone. It is given
 * the later read's id when it saw the same screen, and none otherwise.
 */
import { createHash, randomUUID } from "node:crypto";
import type { ParsedPrompt } from "@shahi/shared";

interface PaneState {
  /** Tickets handed out, and the highest one observed. */
  issued: number;
  seen: number;
  /** The screen that read found, and the id it was given. */
  screen?: string;
  shown?: string;
  /** The appearance on screen now, when there is one. */
  id?: string;
  signature?: string;
  /**
   * The screen an answer was pressed on, until the pane shows another, and
   * the id a card drawn from it carries: never current, so such a card can
   * answer nothing, not even an identical question asked next.
   */
  answeredScreen?: string;
  answeredId?: string;
}

/** Identifies a screen exactly, as the poller's change detection does. */
export function screenId(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

export class PromptInstances {
  readonly #panes = new Map<string, PaneState>();

  /** Taken before a read is sent. */
  ticket(paneId: string): number {
    return ++this.#state(paneId).issued;
  }

  /**
   * Records what a read found, and returns the id of the prompt it shows.
   * `screen` identifies the screen exactly (the poller's hash of it).
   * A read overtaken by a later one changes nothing, and gets an id only if
   * it found the screen the later read did.
   */
  observe(paneId: string, ticket: number, prompt: ParsedPrompt | null, screen: string): string | undefined {
    const state = this.#state(paneId);
    if (ticket < state.seen) return prompt && screen === state.screen ? state.shown : undefined;
    state.seen = ticket;
    state.screen = screen;
    return (state.shown = this.#idFor(state, prompt, screen));
  }

  #idFor(state: PaneState, prompt: ParsedPrompt | null, screen: string): string | undefined {
    if (state.answeredScreen !== undefined) {
      if (state.answeredScreen === screen) return prompt ? state.answeredId : undefined;
      state.answeredScreen = state.answeredId = undefined;
    }
    if (!prompt) {
      state.id = state.signature = undefined;
      return undefined;
    }
    const signature = signatureOf(prompt);
    if (state.id === undefined || signature !== state.signature) {
      state.id = randomUUID();
      state.signature = signature;
    }
    return state.id;
  }

  /** Whether `screen` is the one an answer was already pressed on. */
  alreadyAnswered(paneId: string, screen: string): boolean {
    return this.#panes.get(paneId)?.answeredScreen === screen;
  }

  /** An answer was pressed on `screen`: whatever prompt is seen next is a new appearance. */
  answered(paneId: string, screen: string): void {
    const state = this.#state(paneId);
    state.answeredScreen = screen;
    state.answeredId = randomUUID();
    state.id = state.signature = undefined;
    if (state.screen === screen) state.shown = state.answeredId;
  }

  forget(paneId: string): void {
    this.#panes.delete(paneId);
  }

  #state(paneId: string): PaneState {
    let state = this.#panes.get(paneId);
    if (!state) this.#panes.set(paneId, (state = { issued: 0, seen: 0 }));
    return state;
  }
}

/** What makes two prompts the same question: everything but where the cursor is. */
function signatureOf(prompt: ParsedPrompt): string {
  return JSON.stringify([
    prompt.question,
    prompt.context ?? [],
    prompt.answer,
    prompt.confirm ?? false,
    prompt.options.map((o) => [o.index, o.label, o.detail ?? null]),
  ]);
}
