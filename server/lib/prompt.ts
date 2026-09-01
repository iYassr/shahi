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
 */

/** The three herdr calls this module is allowed to make, typed loosely so a test can fake them. */
export type PromptRpc = (method: string, params: Record<string, unknown>) => Promise<unknown>;

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
  await rpc("pane.send_text", { pane_id: target.paneId, text });
  await sleep(SUBMIT_DELAY_MS);
  await rpc("pane.send_keys", { pane_id: target.paneId, keys: ["Enter"] });
  return "terminal";
}

/**
 * Remembers recent prompts by the phone's own message id.
 *
 * A phone on a bad connection times out and retries; without this the same
 * prompt reaches the agent twice. The window is short and the table small
 * because the case is rare — it only has to outlive one client timeout plus a
 * retry, and the client's ceiling is 15 seconds.
 */
export class PromptReceipts<T> {
  #seen = new Map<string, { at: number; value: T }>();

  constructor(
    private readonly ttlMs = 5 * 60_000,
    private readonly limit = 500,
  ) {}

  get(id: string, now = Date.now()): T | undefined {
    const hit = this.#seen.get(id);
    if (!hit) return undefined;
    if (now - hit.at > this.ttlMs) {
      this.#seen.delete(id);
      return undefined;
    }
    return hit.value;
  }

  put(id: string, value: T, now = Date.now()): void {
    this.#seen.delete(id);
    this.#seen.set(id, { at: now, value });
    // Oldest first, since Map iterates in insertion order.
    for (const [key, hit] of this.#seen) {
      if (this.#seen.size <= this.limit && now - hit.at <= this.ttlMs) break;
      this.#seen.delete(key);
    }
  }
}
