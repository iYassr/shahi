import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GAP_MARKER, TranscriptStore, linesScrolledOff, screenAdvanced } from "./transcript";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const framePair = (name: string) =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as {
    before: string[];
    after: string[];
    expected?: string[];
    changedLines?: number[];
  };

/** A screen body long enough to clear the alignment threshold. */
const body = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => `line ${from + i}`);

describe("linesScrolledOff", () => {
  test("returns nothing when the screen is unchanged", () => {
    const screen = body(0, 20);
    expect(linesScrolledOff(screen, [...screen])).toEqual([]);
  });

  test("detects a single-line scroll", () => {
    const before = body(0, 20);
    const after = [...body(1, 19), "line 20"];
    expect(linesScrolledOff(before, after)).toEqual(["line 0"]);
  });

  test("detects a multi-line scroll", () => {
    const before = body(0, 20);
    const after = [...body(5, 15), ...body(20, 5)];
    expect(linesScrolledOff(before, after)).toEqual(body(0, 5));
  });

  // Claude Code repaints its spinner and token counter constantly. Treating a
  // repaint as a scroll would fill the transcript with near-duplicate frames.
  test("ignores an in-place repaint of the volatile tail", () => {
    const before = [...body(0, 20), "✻ Thinking… (2m 10s · 40k tokens)"];
    const after = [...body(0, 20), "✻ Thinking… (2m 15s · 41k tokens)"];
    expect(linesScrolledOff(before, after)).toEqual([]);
  });

  // Regression, found by watching a live working agent: consecutive frames of a
  // Claude Code pane are identical except for a spinner/token-counter line
  // two-thirds down. Requiring the *whole* overlap to match meant any repaint
  // below the fold vetoed an otherwise genuine scroll, and nothing was ever
  // recorded. The comparison window has to stay clear of the volatile bottom.
  test("detects a scroll despite a repainting status line at the bottom", () => {
    const before = [...body(0, 20), "✻ Seasoning… (14m 40s · 56.6k tokens)", "-- INSERT --"];
    const after = [...body(3, 17), ...body(20, 3), "✻ Seasoning… (14m 44s · 57.1k tokens)", "-- INSERT --"];
    expect(linesScrolledOff(before, after)).toEqual(body(0, 3));
  });

  test("reports the true scroll distance, not a larger coincidental one", () => {
    // A self-similar screen could align at several shifts; the smallest is the
    // real one, and over-reporting would archive lines still on screen.
    const before = [...body(0, 24)];
    const after = [...body(2, 22), ...body(24, 2)];
    expect(linesScrolledOff(before, after)).toEqual(body(0, 2));
  });

  test("records nothing when the screen is wholly replaced", () => {
    expect(linesScrolledOff(body(0, 20), body(100, 20))).toEqual([]);
  });

  test("records nothing when the screen is cleared", () => {
    expect(linesScrolledOff(body(0, 20), Array(20).fill(""))).toEqual([]);
  });

  // A mostly-blank screen would otherwise "align" at every possible shift and
  // fabricate history out of whitespace.
  test("does not align on blank lines alone", () => {
    const before = [...Array(18).fill(""), "only real line", ""];
    const after = [...Array(18).fill(""), "different line", ""];
    expect(linesScrolledOff(before, after)).toEqual([]);
  });

  test("requires a substantial run of agreement", () => {
    // Three matching lines is coincidence, not a scroll.
    const before = ["a", "b", "c", "x1", "x2", "x3", "x4"];
    const after = ["x1", "x2", "x3", "y1", "y2", "y3", "y4"];
    expect(linesScrolledOff(before, after)).toEqual([]);
  });

  // Consecutive frames captured from a live Claude Code pane. Synthetic screens
  // are too well-behaved to prove anything here — the first version of this
  // function passed every synthetic test and still recorded nothing at all
  // against the real thing.
  describe("real captured frames", () => {
    test("recovers the scrolled lines from a genuine scroll", () => {
      const { before, after, expected } = framePair("scroll-pair.json");
      expect(linesScrolledOff(before, after)).toEqual(expected!);
      expect(expected!.length).toBeGreaterThan(0);
    });

    test("records nothing for a spinner-only repaint", () => {
      const { before, after, changedLines } = framePair("repaint-pair.json");

      // Exactly one line differs, two-thirds down the screen: the status line
      // with its elapsed timer and token counter.
      expect(changedLines).toHaveLength(1);
      expect(before[changedLines![0]!]).not.toBe(after[changedLines![0]!]);
      expect(linesScrolledOff(before, after)).toEqual([]);
    });
  });
});

describe("TranscriptStore", () => {
  const store = () => new TranscriptStore(":memory:");

  test("records nothing on first sight of a pane", () => {
    const s = store();
    expect(s.record("w1:p1", body(0, 20).join("\n"))).toBe(0);
    expect(s.count("w1:p1")).toBe(0);
    s.close();
  });

  test("accumulates scrolled-off lines in order", () => {
    const s = store();
    s.record("w1:p1", body(0, 20).join("\n"));
    s.record("w1:p1", [...body(3, 17), ...body(20, 3)].join("\n"));
    s.record("w1:p1", [...body(6, 17), ...body(23, 3)].join("\n"));

    expect(s.tail("w1:p1").map((l) => l.text)).toEqual(body(0, 6));
    expect(s.count("w1:p1")).toBe(6);
    s.close();
  });

  // Output can arrive faster than the poll interval; herdr keeps no scrollback
  // to recover it. Admitting the gap beats splicing unrelated output together
  // into something that reads as continuous.
  test("marks a gap when more than a screenful passed between polls", () => {
    const s = store();
    s.record("w1:p1", body(0, 20).join("\n"));
    expect(s.record("w1:p1", body(500, 20).join("\n"))).toBe(1);

    expect(s.tail("w1:p1").map((l) => l.text)).toEqual([GAP_MARKER]);
    s.close();
  });

  test("does not mark a gap for a repaint", () => {
    const s = store();
    const screen = [...body(0, 20), "✻ Thinking… (1m 02s)"];
    s.record("w1:p1", screen.join("\n"));
    expect(s.record("w1:p1", [...body(0, 20), "✻ Thinking… (1m 07s)"].join("\n"))).toBe(0);
    expect(s.count("w1:p1")).toBe(0);
    s.close();
  });

  test("keeps panes independent", () => {
    const s = store();
    for (const pane of ["w1:p1", "w2:p1"]) {
      s.record(pane, body(0, 20).join("\n"));
      s.record(pane, [...body(2, 18), ...body(20, 2)].join("\n"));
    }
    expect(s.count("w1:p1")).toBe(2);
    expect(s.count("w2:p1")).toBe(2);
    s.forget("w1:p1");
    expect(s.count("w1:p1")).toBe(0);
    expect(s.count("w2:p1")).toBe(2);
    s.close();
  });

  test("pages backwards through history", () => {
    const s = store();
    s.record("w1:p1", body(0, 20).join("\n"));
    s.record("w1:p1", [...body(10, 10), ...body(20, 10)].join("\n"));

    const all = s.tail("w1:p1");
    expect(all).toHaveLength(10);

    const older = s.before("w1:p1", all[5]!.seq);
    expect(older.map((l) => l.text)).toEqual(body(0, 5));
    s.close();
  });

  test("prunes to the retention limit, discarding the oldest", () => {
    const s = new TranscriptStore(":memory:", { maxLinesPerPane: 10, pruneEvery: 1 });

    // Scroll a 20-line window forward 4 lines at a time, 6 times, so 24 lines
    // ("line 0".."line 23") pass out of view against a 10-line retention cap.
    s.record("w1:p1", body(0, 20).join("\n"));
    for (let step = 1; step <= 6; step++) {
      s.record("w1:p1", body(step * 4, 20).join("\n"));
    }

    expect(s.count("w1:p1")).toBe(10);
    // Exactly the newest ten of the twenty-four, still oldest-first.
    expect(s.tail("w1:p1").map((l) => l.text)).toEqual(body(14, 10));
    s.close();
  });

  test("survives a reopen", () => {
    const path = `/tmp/herdrui-test-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`;
    const first = new TranscriptStore(path);
    first.record("w1:p1", body(0, 20).join("\n"));
    first.record("w1:p1", [...body(4, 16), ...body(20, 4)].join("\n"));
    expect(first.count("w1:p1")).toBe(4);
    first.close();

    const second = new TranscriptStore(path);
    expect(second.count("w1:p1")).toBe(4);
    expect(second.tail("w1:p1").map((l) => l.text)).toEqual(body(0, 4));

    // Sequence numbers continue rather than colliding with the restored rows.
    second.record("w1:p1", body(4, 20).join("\n"));
    second.record("w1:p1", [...body(6, 18), ...body(24, 2)].join("\n"));
    expect(second.count("w1:p1")).toBe(6);
    expect(second.tail("w1:p1").map((l) => l.text)).toEqual([...body(0, 4), ...body(4, 2)]);
    second.close();
  });
});

describe("screenAdvanced", () => {
  test("false when only the volatile bottom repainted", () => {
    const { before, after } = framePair("repaint-pair.json");
    expect(screenAdvanced(before, after)).toBe(false);
  });

  test("true when the content genuinely scrolled", () => {
    const { before, after } = framePair("scroll-pair.json");
    expect(screenAdvanced(before, after)).toBe(true);
  });

  test("true when the screen was wholly replaced", () => {
    expect(screenAdvanced(body(0, 20), body(500, 20))).toBe(true);
  });
});

describe("gap coalescing", () => {
  test("collapses a run of gaps into one marker", () => {
    const s = new TranscriptStore(":memory:");
    s.record("w1:p1", body(0, 20).join("\n"));
    for (let i = 1; i <= 5; i++) s.record("w1:p1", body(i * 500, 20).join("\n"));

    expect(s.tail("w1:p1").map((l) => l.text)).toEqual([GAP_MARKER]);
    s.close();
  });

  test("a later real scroll is recorded after a gap", () => {
    const s = new TranscriptStore(":memory:");
    s.record("w1:p1", body(0, 20).join("\n"));
    s.record("w1:p1", body(500, 20).join("\n"));
    s.record("w1:p1", [...body(503, 17), ...body(520, 3)].join("\n"));

    expect(s.tail("w1:p1").map((l) => l.text)).toEqual([GAP_MARKER, ...body(500, 3)]);
    s.close();
  });
});
