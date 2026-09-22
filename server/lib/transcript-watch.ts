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

/**
 * Watches whichever transcript `locate` names, and moves when it names another.
 *
 * A herdr pane outlives the conversation in it: `/clear` in Claude, a new codex
 * or Cursor session, or a codex process exiting all leave the pane reading a
 * different file. The server resolved the path once and then watched the first
 * file for as long as the pane stayed open, so pushes stopped after a switch
 * and the reader fell back to its 2.5s poll (review finding, September 2026).
 *
 * So the path is looked up again every `relocateMs`: 3s, because herdr's
 * session ids reach the mirror on its 3s re-snapshot and cannot change faster
 * than that. `wake` looks it up at once, but only while nothing is watched yet;
 * the server calls it on each frame, since the first frame after a new agent
 * speaks is when its file appears. A lookup that finds nothing keeps the file
 * already watched: a failed lookup is usually a moment's absence, and reporting
 * growth of a file the pane has left costs the reader one request, not a wrong
 * message, because every read resolves the transcript afresh.
 *
 * Moving is reported as a change, so the reader fetches the new conversation
 * now rather than on its next poll or the new file's next write.
 */
export function followTranscript(
  locate: () => Promise<string | null>,
  onChange: (offset: number) => void,
  { relocateMs = 3_000, ...options }: WatchOptions & { relocateMs?: number } = {},
): { wake: () => void; stop: () => void } {
  let path: string | null = null;
  let stopFile: (() => void) | null = null;
  let locating = false;
  let stopped = false;

  const relocate = async () => {
    if (stopped || locating) return;
    locating = true;
    try {
      const next = await locate();
      if (stopped || !next || next === path) return;
      const moved = path !== null;
      stopFile?.();
      path = next;
      stopFile = watchTranscript(next, onChange, options);
      if (!moved) return;
      const { size } = await stat(next);
      if (!stopped) onChange(size);
    } catch {
      // Best-effort: the reader's own poll still covers a missed push.
    } finally {
      locating = false;
    }
  };

  const interval = setInterval(() => void relocate(), relocateMs);
  void relocate();

  return {
    wake: () => {
      if (!stopFile) void relocate();
    },
    stop: () => {
      stopped = true;
      clearInterval(interval);
      stopFile?.();
      stopFile = null;
    },
  };
}
