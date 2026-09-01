/**
 * At most one run of `fn` in flight, and at most one more queued.
 *
 * The reader refreshes from three places — its own timer, a pushed frame, and a
 * `log_changed` — and while an agent is repainting its terminal those arrive
 * faster than a transcript fetch returns. Without this, every repaint started
 * another fetch and a busy pane had several identical requests outstanding at
 * once. Now a refresh asked for during a run marks one rerun, and however many
 * arrive during that run collapse into that single rerun: the last one always
 * sees the latest state, and nothing in between was going to show anything the
 * rerun will not.
 */
export function coalesce(fn: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let rerun: { promise: Promise<void>; resolve: () => void } | null = null;

  const start = (): Promise<void> => {
    const run = fn()
      // A failed run must not wedge the next one; `fn` reports its own
      // failures through state.
      .catch(() => undefined)
      .then(() => {
        running = null;
        const wanted = rerun;
        rerun = null;
        if (wanted) void start().then(wanted.resolve);
      });
    running = run;
    return run;
  };

  return () => {
    if (!running) return start();
    if (!rerun) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      rerun = { promise, resolve };
    }
    return rerun.promise;
  };
}
