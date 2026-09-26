/**
 * One writer at a time per pane.
 *
 * A prompt is a screen read, text, a 200ms pause and Enter; an answer is a
 * read and then keys. Nothing ordered two of them on the same pane, so input
 * from another phone landed inside another request's read-to-Enter window:
 * two messages merged into one submission, a message's Enter chose a menu
 * row, a key-bar Up between an answer's read and its Enter confirmed "No,
 * exit" and quit the agent — each told 200 (pre-release bug hunt, B6). Every
 * write route runs its herdr calls through `run`, so each sees the screen the
 * one before it left. Reads stay outside: the poller must not wait on a write.
 */
export class PaneWrites {
  readonly #tails = new Map<string, Promise<void>>();

  run<T>(paneId: string, action: () => Promise<T>): Promise<T> {
    const result = (this.#tails.get(paneId) ?? Promise.resolve()).then(action);
    const tail = result.then(() => undefined, () => undefined);
    this.#tails.set(paneId, tail);
    // Dropped once idle, so a box that has seen a thousand panes holds none.
    void tail.then(() => {
      if (this.#tails.get(paneId) === tail) this.#tails.delete(paneId);
    });
    return result;
  }
}
