/**
 * Runs `task` with an abort signal that fires after `ms`, and clears that timer
 * the moment the task settles. `AbortSignal.timeout` does not: its timer stays
 * pending after the fetch it guarded has finished, and a pending timer keeps a
 * Durable Object awake and billed. Measured in September 2026, every monitor
 * check finished in about half a second and was billed for 15 — the longest
 * such timeout — which came to 83,000 GB-s a month, a fifth of the account's
 * included Durable Object duration.
 */
export async function withDeadline<T>(ms: number, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), ms);
  try { return await task(controller.signal); } finally { clearTimeout(timer); }
}
