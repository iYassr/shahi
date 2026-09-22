/**
 * Whether a failed operation's herdr calls could have changed anything.
 *
 * Prompts and agent starts are retried under the id that first carried them,
 * and `Operations` hands every retry the first outcome, so a lost response
 * never becomes a second message or a second agent. That is right for an
 * uncertain failure and wrong for a definite one. A send made while herdr was
 * restarting answered "no herdr socket" and kept answering it for ten minutes
 * after herdr was back, because the phone retries with the same id until the
 * text changes (review finding F93).
 *
 * So an operation's calls go through a tracker. A call that succeeded may
 * have changed something. A call that failed may have too, unless it failed
 * before herdr could act: the socket would not open, so nothing was written,
 * or herdr refused with a code that says it did nothing. An operation whose
 * every call failed that way has sent nothing, and its failure need not be
 * kept. Anything not recognised here counts as delivered, because the safe
 * mistake is a replayed error, never a repeated write.
 */
import { HerdrError } from "./herdr-client";

/** Opening the socket failed, so the request was never written to it. */
const NOT_CONNECTED = new Set(["ENOENT", "ECONNREFUSED", "EACCES", "ENOTSOCK"]);

/**
 * Refusals about the target itself, made before herdr acts on it.
 * `agent_blocked` is documented as "rejected before any input is sent".
 */
const REFUSED = new Set(["agent_not_ready", "agent_blocked", "agent_not_found", "pane_not_found"]);

/** True when `err` proves the call it came from did nothing in herdr. */
export function refusedBeforeDelivery(err: unknown): boolean {
  if (err instanceof HerdrError) return REFUSED.has(err.code) || err.code.startsWith("invalid_");
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && NOT_CONNECTED.has(code);
}

type Rpc = (method: string, params: never, options?: { timeoutMs?: number }) => Promise<unknown>;

/**
 * Wraps `rpc` for one operation. `reachedNothing` answers, once the operation
 * has failed, whether none of its calls could have changed anything.
 */
export function trackDelivery<R extends Rpc>(rpc: R): { rpc: R; reachedNothing: () => boolean } {
  let delivered = false;
  const tracked = (async (method: string, params: never, options?: { timeoutMs?: number }) => {
    try {
      const result = await rpc(method, params, options);
      delivered = true;
      return result;
    } catch (err) {
      if (!refusedBeforeDelivery(err)) delivered = true;
      throw err;
    }
  }) as R;
  return { rpc: tracked, reachedNothing: () => !delivered };
}
