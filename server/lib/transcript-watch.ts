/**
 * Tells a watcher when a transcript file has grown.
 *
 * The reader is fed by the agent's transcript, not the terminal — so the
 * terminal repainting is the wrong signal to refresh on, and a 2.5s poll is the
 * wrong cadence for a reply that was written milliseconds ago. This watches the
 * file itself and reports its new size; the server turns that into one
 * `log_changed` message for the client watching that pane, which then fetches
 * the tail it needs. Nothing about the content is read or reported here.
 *
 * Two mechanisms, because neither is sufficient alone: `fs.watch` is prompt but
 * can miss events (and on some filesystems never fires), so a size check on an
 * interval backs it up. Bursts of writes collapse into one report per debounce
 * window. A file that shrinks or is replaced is reported too — the reader's
 * index keys on size and rebuilds from a smaller one.
 */
import { watch as fsWatch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";

export interface WatchOptions {
  /** How long to wait after the last change before reporting. */
  debounceMs?: number;
  /** How often to check the size when `fs.watch` says nothing. */
  fallbackMs?: number;
}

/**
 * Watches `path` until the returned function is called.
 *
 * `onChange` receives the file's current size whenever it differs from the last
 * size reported. The first call reports nothing: the reader already fetched the
 * file when it opened the pane.
 */
export function watchTranscript(
  path: string,
  onChange: (offset: number) => void,
  { debounceMs = 40, fallbackMs = 1_000 }: WatchOptions = {},
): () => void {
  let lastSize = -1;
  let stopped = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let checking = false;

  const check = async () => {
    if (stopped || checking) return;
    checking = true;
    try {
      const size = (await stat(path)).size;
      if (lastSize === -1) {
        lastSize = size;
      } else if (size !== lastSize) {
        lastSize = size;
        onChange(size);
      }
    } catch {
      // Gone, or not there yet. The next tick will see it if it comes back.
    } finally {
      checking = false;
    }
  };

  const schedule = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void check(), debounceMs);
  };

  // Seed the size now so the first real change is reported as one.
  void check();

  let watcher: FSWatcher | undefined;
  try {
    watcher = fsWatch(path, () => schedule());
    watcher.on("error", () => watcher?.close());
  } catch {
    // Left to the interval.
  }
  const interval = setInterval(() => void check(), fallbackMs);

  return () => {
    stopped = true;
    if (debounce) clearTimeout(debounce);
    clearInterval(interval);
    watcher?.close();
  };
}
