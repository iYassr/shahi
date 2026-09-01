import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchTranscript } from "./transcript-watch";

/**
 * One coalesced report per burst, and a report for a file that shrank.
 *
 * The intervals are short here so the suite stays fast; the mechanism is the
 * same one the server runs with 40ms/1s.
 */
const dir = mkdtempSync(join(tmpdir(), "shahi-watch-"));
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

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
