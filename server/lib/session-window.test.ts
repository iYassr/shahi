/**
 * A reader's page against the relay's frame.
 *
 * The pre-release bug hunt put one ~800 KB message among a conversation's last
 * sixty: through the relay every poll was a 413, and the phone said "Nothing
 * to read yet" about a conversation it had been reading. These read real
 * transcripts off disk, as the route does, and bound the page as it does.
 */
import { RELAY_LIMITS, type SessionLog } from "@shahi/shared";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWindow } from "./session-log";
import { fitPage, MAX_BLOCK_CHARS, PAGE_BUDGET_BYTES } from "./session-window";

const dir = mkdtempSync(join(tmpdir(), "shahi-window-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const row = (i: number, text: string) =>
  JSON.stringify({
    type: i % 2 ? "assistant" : "user",
    uuid: `m${i}`,
    timestamp: "2026-09-25T00:00:00.000Z",
    message: { role: i % 2 ? "assistant" : "user", content: [{ type: "text", text }] },
  });

function transcript(name: string, texts: string[]): string {
  const path = join(dir, `${name}.jsonl`);
  writeFileSync(path, `${texts.map((text, i) => row(i, text)).join("\n")}\n`);
  return path;
}

const weight = (log: SessionLog) => Buffer.byteLength(JSON.stringify(log));
const texts = (log: SessionLog) => log.messages.map((m) => (m.blocks[0] as { text: string }).text);

test("a page's budget leaves room in a relay body", () => {
  expect(PAGE_BUDGET_BYTES).toBeLessThan(RELAY_LIMITS.maxBodyBytes);
});

describe("a conversation too large for the relay", () => {
  test("one very large message among the last sixty is shortened, says so, and the page fits", async () => {
    const huge = "x".repeat(800_000);
    const path = transcript("huge", Array.from({ length: 80 }, (_, i) => (i === 50 ? huge : `message ${i}`)));
    const window = (await readWindow(path, { limit: 60 }))!;
    expect(weight(window)).toBeGreaterThan(RELAY_LIMITS.maxBodyBytes);

    const page = fitPage(window);
    expect(weight(page)).toBeLessThanOrEqual(PAGE_BUDGET_BYTES);
    expect(page.total).toBe(80);
    // Nothing is left out: the sixty asked for, the large one among them, cut.
    expect(page.messages.map((m) => m.id)).toEqual(window.messages.map((m) => m.id));
    const shortened = texts(page)[30]!;
    expect(shortened.startsWith("x".repeat(MAX_BLOCK_CHARS))).toBe(true);
    expect(shortened).toContain("768,000 more characters");
    expect(shortened).toContain("The whole message is in the transcript on your computer.");
  });

  test("a long stretch of thinking is shortened like a message", async () => {
    const path = join(dir, "thinking.jsonl");
    writeFileSync(path, `${JSON.stringify({
      type: "assistant", uuid: "t0", timestamp: "2026-09-25T00:00:00.000Z",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "t".repeat(900_000) }, { type: "text", text: "done" }] },
    })}\n`);
    const page = fitPage((await readWindow(path, { limit: 60 }))!);
    expect(weight(page)).toBeLessThanOrEqual(PAGE_BUDGET_BYTES);
    expect(page.messages[0]!.blocks.map((b) => b.kind)).toEqual(["thinking", "text"]);
    expect((page.messages[0]!.blocks[0] as { text: string }).text).toContain("868,000 more characters");
  });

  test("a window of many long messages keeps its newest, and Load earlier reaches the rest without a gap", async () => {
    const long = (i: number) => `${i} ${"y".repeat(20_000)}`;
    const path = transcript("long", Array.from({ length: 70 }, (_, i) => long(i)));

    const tail = fitPage((await readWindow(path, { limit: 60 }))!);
    expect(weight(tail)).toBeLessThanOrEqual(PAGE_BUDGET_BYTES);
    expect(tail.messages.length).toBeGreaterThan(0);
    expect(tail.messages.length).toBeLessThan(60);
    expect(tail.messages.at(-1)!.id).toBe((await readWindow(path, { limit: 1 }))!.messages[0]!.id);

    // What both clients do next: ask for the page that ends where this began.
    const before = tail.total - tail.messages.length;
    const older = fitPage((await readWindow(path, { limit: 60, before }))!);
    const whole = (await readWindow(path, { limit: 70 }))!.messages.map((m) => m.id);
    expect([...older.messages, ...tail.messages].map((m) => m.id)).toEqual(whole.slice(before - older.messages.length));
  });

  // An empty page reads as an empty conversation, which is the claim this
  // fixes; a page too heavy for the relay at least says why.
  test("the newest message is sent even when it alone outweighs the budget", async () => {
    const window = (await readWindow(transcript("tiny-budget", ["one", "two", "three"]), { limit: 60 }))!;
    expect(texts(fitPage(window, 10))).toEqual(["three"]);
  });

  test("a page that fits is sent as it was read", async () => {
    const window = (await readWindow(transcript("small", ["hello", "hi", "a".repeat(MAX_BLOCK_CHARS)]), { limit: 60 }))!;
    expect(fitPage(window)).toBe(window);
  });

  test("a long message is never cut between the halves of an emoji", async () => {
    const text = `${"z".repeat(MAX_BLOCK_CHARS - 1)}😀${"z".repeat(10)}`;
    const page = fitPage((await readWindow(transcript("emoji", [text]), { limit: 60 }))!);
    const kept = texts(page)[0]!.split("\n\n…")[0]!;
    expect(kept).toBe("z".repeat(MAX_BLOCK_CHARS - 1));
  });
});
