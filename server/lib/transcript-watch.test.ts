import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { followTranscript, watchTranscript } from "./transcript-watch";

/**
 * One coalesced report per burst, and a report for a file that shrank.
 *
 * The intervals are short here so the suite stays fast; the mechanism is the
 * same one the server runs with 40ms/1s.
 */
const dir = mkdtempSync(join(tmpdir(), "shahi-watch-"));
// An afterAll: the "exit" listener this used to rely on never removed it, and
// every run left the directory in $TMPDIR until the September 2026 review.
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

const until = async (pred: () => boolean, ms = 2_000) => {
  const deadline = Date.now() + ms;
  while (!pred() && Date.now() < deadline) await Bun.sleep(10);
};

describe("watchTranscript", () => {
  test("a burst of appends becomes one report carrying the new size", async () => {
    const path = join(dir, "a.jsonl");
    writeFileSync(path, "line1\n");
    const seen: number[] = [];
    stops.push(watchTranscript(path, (offset) => seen.push(offset), { debounceMs: 30, fallbackMs: 200 }));
    await Bun.sleep(50); // let it seed the current size
    appendFileSync(path, "line2\n");
    appendFileSync(path, "line3\n");
    appendFileSync(path, "line4\n");
    await until(() => seen.length > 0);
    await Bun.sleep(150); // no second report for the same burst
    expect(seen).toEqual([24]);
  });

  test("nothing is reported for a file that does not change", async () => {
    const path = join(dir, "b.jsonl");
    writeFileSync(path, "x\n");
    const seen: number[] = [];
    stops.push(watchTranscript(path, (offset) => seen.push(offset), { debounceMs: 10, fallbackMs: 50 }));
    await Bun.sleep(200);
    expect(seen).toEqual([]);
  });

  test("a file that shrinks is reported too, so the index can rebuild", async () => {
    const path = join(dir, "c.jsonl");
    writeFileSync(path, "a long first version of the file\n");
    const seen: number[] = [];
    stops.push(watchTranscript(path, (offset) => seen.push(offset), { debounceMs: 10, fallbackMs: 50 }));
    await Bun.sleep(80);
    truncateSync(path, 4);
    await until(() => seen.length > 0);
    expect(seen[0]).toBe(4);
  });

  test("stopping stops", async () => {
    const path = join(dir, "d.jsonl");
    writeFileSync(path, "x\n");
    const seen: number[] = [];
    const stop = watchTranscript(path, (offset) => seen.push(offset), { debounceMs: 10, fallbackMs: 50 });
    await Bun.sleep(80);
    stop();
    appendFileSync(path, "more\n");
    await Bun.sleep(200);
    expect(seen).toEqual([]);
  });
});

/**
 * A pane outlives the conversation in it, and the push watcher used to stay on
 * the first transcript it found: after /clear or a new codex session, pushes
 * stopped and the reader fell back to its poll (review finding, September 2026).
 */
describe("followTranscript", () => {
  const follow = (locate: () => Promise<string | null>, seen: number[], relocateMs: number) => {
    const handle = followTranscript(locate, (offset) => seen.push(offset), { debounceMs: 10, fallbackMs: 50, relocateMs });
    stops.push(handle.stop);
    return handle;
  };

  test("after the pane moves to a new transcript, pushes follow it and leave the old one", async () => {
    const first = join(dir, "first.jsonl");
    const second = join(dir, "second.jsonl");
    writeFileSync(first, "old\n");
    writeFileSync(second, "a new session\n");
    let current = first;
    const seen: number[] = [];
    follow(async () => current, seen, 60);
    await Bun.sleep(80);
    appendFileSync(first, "old reply\n");
    await until(() => seen.length === 1);
    expect(seen).toEqual([14]);

    current = second;
    // The move itself is news: the reader should fetch the new conversation now.
    await until(() => seen.length === 2);
    expect(seen).toEqual([14, 14]);
    appendFileSync(second, "new reply\n");
    await until(() => seen.length === 3);
    appendFileSync(first, "the old file is no longer this pane's\n");
    await Bun.sleep(200);
    expect(seen).toEqual([14, 14, 24]);
  });

  test("a lookup that finds nothing keeps watching the transcript it has", async () => {
    const path = join(dir, "kept.jsonl");
    writeFileSync(path, "x\n");
    let found: string | null = path;
    const seen: number[] = [];
    follow(async () => found, seen, 30);
    await Bun.sleep(60);
    found = null;
    await Bun.sleep(90);
    appendFileSync(path, "y\n");
    await until(() => seen.length > 0);
    expect(seen).toEqual([4]);
  });

  test("a frame finds a just-started agent's transcript without waiting for the next lookup", async () => {
    const path = join(dir, "fresh.jsonl");
    let found: string | null = null;
    const seen: number[] = [];
    const handle = follow(async () => found, seen, 60_000);
    await Bun.sleep(20);
    writeFileSync(path, "hello\n");
    found = path;
    handle.wake();
    await Bun.sleep(80);
    appendFileSync(path, "reply\n");
    await until(() => seen.length > 0);
    expect(seen).toEqual([12]);
  });

  test("stopping stops following", async () => {
    const first = join(dir, "stop-first.jsonl");
    const second = join(dir, "stop-second.jsonl");
    writeFileSync(first, "x\n");
    writeFileSync(second, "y\n");
    let current = first;
    let lookups = 0;
    const seen: number[] = [];
    const handle = follow(async () => { lookups++; return current; }, seen, 30);
    await Bun.sleep(60);
    handle.stop();
    const after = lookups;
    current = second;
    appendFileSync(first, "more\n");
    await Bun.sleep(150);
    expect(seen).toEqual([]);
    expect(lookups).toBe(after);
  });
});
