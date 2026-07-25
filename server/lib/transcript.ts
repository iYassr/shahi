/**
 * Scrollback recorder.
 *
 * herdr's API socket has no scrollback: `pane.read` returns the current visible
 * screen and nothing else. This was verified against the live server — `lines`
 * of 50, 200 and 2000 all return the same 42 rows, and every pane reports
 * `scroll.max_offset_from_bottom: 0`. There is also no scroll method to drive
 * the pane from outside.
 *
 * So the history has to be built here. Each time a pane's screen changes, the
 * new screen is aligned against the previous one and whatever scrolled off the
 * top is appended to a per-pane ring buffer. On a phone, where you cannot
 * simply scroll the real terminal, this is what makes a long agent answer
 * readable at all.
 *
 * Storage is SQLite via `bun:sqlite`, so history survives a restart.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface TranscriptLine {
  seq: number;
  text: string;
  /** Epoch ms when the line was first observed scrolling out of view. */
  at: number;
}

/**
 * Stands in for output that scrolled past between two polls.
 *
 * Rendered distinctly by the UI so a gap never reads as continuous output.
 */
export const GAP_MARKER = "… output not captured …";

export interface TranscriptOptions {
  /** Lines retained per pane. ~5000 is a few hundred KB across a busy session. */
  maxLinesPerPane?: number;
  /** How often to prune overflow, in writes. Pruning every write is wasteful. */
  pruneEvery?: number;
}

export class TranscriptStore {
  readonly #db: Database;
  readonly #maxLines: number;
  readonly #pruneEvery: number;
  #writesSincePrune = 0;

  /** Last screen seen per pane, for diffing. Not persisted; rebuilt on restart. */
  #lastScreen = new Map<string, string[]>();

  /** Whether the last thing written for a pane was a gap marker, to coalesce runs. */
  #lastWasGap = new Map<string, boolean>();

  constructor(dbPath: string, options: TranscriptOptions = {}) {
    this.#maxLines = options.maxLinesPerPane ?? 5_000;
    this.#pruneEvery = options.pruneEvery ?? 200;

    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new Database(dbPath, { create: true });

    // WAL keeps the frequent small appends from blocking reads.
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA synchronous = NORMAL");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS transcript (
        pane_id TEXT NOT NULL,
        seq     INTEGER NOT NULL,
        text    TEXT NOT NULL,
        at      INTEGER NOT NULL,
        PRIMARY KEY (pane_id, seq)
      )
    `);
    this.#db.exec("CREATE INDEX IF NOT EXISTS transcript_pane_seq ON transcript (pane_id, seq DESC)");
  }

  /**
   * Records a newly-observed screen for a pane, returning how many lines were
   * committed to history.
   *
   * Call this only when the screen has actually changed — the poller decides
   * that by hashing, since herdr's `revision` field does not track output.
   */
  record(paneId: string, screen: string): number {
    const next = screen.split("\n").map((l) => l.trimEnd());
    const previous = this.#lastScreen.get(paneId);
    this.#lastScreen.set(paneId, next);

    // First sighting: seed the diff baseline without inventing history. The
    // screen itself is always available live, so nothing is lost.
    if (!previous) return 0;

    let scrolled = linesScrolledOff(previous, next);

    if (scrolled.length === 0) {
      // Nothing aligned. Usually that means the screen was only repainted —
      // correct, and by far the common case. But if the top of the screen moved
      // too, more than a screenful arrived between polls and the intervening
      // output is simply gone: herdr keeps no scrollback to go back for, and
      // polling faster only narrows the window, never closes it.
      //
      // Record the gap rather than papering over it. A transcript that admits
      // it lost something is far more useful than one that splices unrelated
      // output into a seamless-looking lie.
      if (!screenAdvanced(previous, next)) return 0;

      // A fast-moving agent produces a run of these. One marker says "output was
      // lost here" just as well as eight, and eight crowds out the real content
      // either side of it.
      if (this.#lastWasGap.get(paneId)) return 0;
      scrolled = [GAP_MARKER];
    }
    this.#lastWasGap.set(paneId, scrolled[0] === GAP_MARKER && scrolled.length === 1);

    const at = Date.now();
    const nextSeq = this.#nextSeq(paneId);
    const insert = this.#db.prepare(
      "INSERT OR REPLACE INTO transcript (pane_id, seq, text, at) VALUES (?, ?, ?, ?)",
    );
    this.#db.transaction(() => {
      scrolled.forEach((text, i) => insert.run(paneId, nextSeq + i, text, at));
    })();

    this.#writesSincePrune += scrolled.length;
    if (this.#writesSincePrune >= this.#pruneEvery) {
      this.#writesSincePrune = 0;
      this.prune(paneId);
    }
    return scrolled.length;
  }

  /** Most recent `limit` lines, oldest first. */
  tail(paneId: string, limit = 500): TranscriptLine[] {
    return this.#db
      .query<TranscriptLine, [string, number]>(
        "SELECT seq, text, at FROM transcript WHERE pane_id = ? ORDER BY seq DESC LIMIT ?",
      )
      .all(paneId, limit)
      .reverse();
  }

  /** Lines strictly before `beforeSeq`, oldest first — for paging upward. */
  before(paneId: string, beforeSeq: number, limit = 500): TranscriptLine[] {
    return this.#db
      .query<TranscriptLine, [string, number, number]>(
        "SELECT seq, text, at FROM transcript WHERE pane_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
      )
      .all(paneId, beforeSeq, limit)
      .reverse();
  }

  count(paneId: string): number {
    return (
      this.#db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM transcript WHERE pane_id = ?")
        .get(paneId)?.n ?? 0
    );
  }

  /** Drops everything for a pane. Called when herdr reports the pane closed. */
  forget(paneId: string): void {
    this.#db.run("DELETE FROM transcript WHERE pane_id = ?", [paneId]);
    this.#lastScreen.delete(paneId);
    this.#lastWasGap.delete(paneId);
  }

  /** Trims a pane back to `maxLinesPerPane`. */
  prune(paneId: string): void {
    this.#db.run(
      `DELETE FROM transcript
         WHERE pane_id = ?1
           AND seq <= COALESCE(
             (SELECT seq FROM transcript WHERE pane_id = ?1 ORDER BY seq DESC LIMIT 1 OFFSET ?2),
             -1
           )`,
      [paneId, this.#maxLines],
    );
  }

  close(): void {
    this.#db.close();
  }

  #nextSeq(paneId: string): number {
    const row = this.#db
      .query<{ maxSeq: number | null }, [string]>(
        "SELECT MAX(seq) AS maxSeq FROM transcript WHERE pane_id = ?",
      )
      .get(paneId);
    return (row?.maxSeq ?? -1) + 1;
  }
}

/**
 * Returns the lines that fell off the top between two screens.
 *
 * Finds the smallest `shift` where `previous[shift..]` continues into the head
 * of `next` — how far the content scrolled — and returns `previous[0..shift]`.
 *
 * The subtlety is *where* to compare. A terminal screen has a stable body and a
 * volatile bottom: Claude Code repaints a spinner, an elapsed timer, a token
 * counter and an editable composer on every frame. Observed against a live
 * working agent, consecutive frames were identical except for a single line
 * two-thirds down, ticking once or twice a second.
 *
 * So the comparison deliberately looks only at a window near the *top* of the
 * incoming screen. Requiring the whole overlap to match — the obvious reading
 * of "did this scroll?" — means any repaint below the fold vetoes an otherwise
 * genuine scroll, and nothing is ever recorded.
 *
 * When no shift aligns, the screen was repainted rather than scrolled and
 * nothing has truly left the buffer, so nothing is recorded. Silence is the
 * right failure here: the live screen is always available anyway, and the
 * alternative is a transcript full of near-duplicate frames.
 */
export function linesScrolledOff(previous: string[], next: string[]): string[] {
  // A full repaint to a blank screen (clear, alternate-screen switch) carries
  // no history worth keeping.
  if (next.every((l) => l.trim() === "")) return [];

  // The smallest shift is the true scroll distance; a larger one that also
  // happens to align would over-report and drop lines that are still on screen.
  for (let shift = 1; shift < previous.length; shift++) {
    if (alignsAt(previous, next, shift)) return previous.slice(0, shift);
  }

  return [];
}

/**
 * True when `previous[shift..]` continues into the head of `next`.
 *
 * Compares a bounded window from the top of `next` rather than the whole
 * overlap, so a repainting status line further down cannot veto the match.
 * Blank lines match but do not count as evidence — a mostly-empty screen would
 * otherwise "align" at every possible shift and fabricate history out of
 * whitespace.
 */
function alignsAt(previous: string[], next: string[], shift: number): boolean {
  const window = Math.min(ALIGNMENT_WINDOW, previous.length - shift, next.length);
  if (window < MIN_ALIGNMENT_LINES) return false;

  let substantive = 0;
  for (let i = 0; i < window; i++) {
    const before = previous[shift + i];
    if (before !== next[i]) return false;
    if (before !== undefined && before.trim() !== "") substantive++;
  }
  return substantive >= MIN_ALIGNMENT_LINES;
}

/**
 * True when the *top* of the screen changed, meaning content genuinely moved.
 *
 * This is what separates "the agent repainted its spinner" — the overwhelmingly
 * common case, where recording nothing is correct — from "output scrolled past
 * faster than we could poll", where recording nothing loses history silently.
 * Measured against a live working agent: 176 repaint-only frames to 1 real
 * advance over 75 seconds.
 */
export function screenAdvanced(previous: string[], next: string[]): boolean {
  const depth = Math.min(HEAD_PROBE_LINES, previous.length, next.length);
  if (depth === 0) return false;
  for (let i = 0; i < depth; i++) {
    if (previous[i] !== next[i]) return true;
  }
  return false;
}

/** How many lines from the top must be unchanged to call a frame a repaint. */
const HEAD_PROBE_LINES = 3;

/**
 * How much of the incoming screen to compare.
 *
 * Wide enough that agreement cannot be coincidence, short enough to stay clear
 * of the volatile bottom of a 42-row pane.
 */
const ALIGNMENT_WINDOW = 16;

/**
 * How many matching non-blank lines constitute a real alignment.
 *
 * Too low and unrelated screens align by chance, inventing history; too high
 * and a scroll that lands next to a run of blank lines is missed.
 */
const MIN_ALIGNMENT_LINES = 6;
