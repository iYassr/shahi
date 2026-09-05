import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normaliseCodex, readCodexWindow, type CodexReadStats } from "./codex-log";

const dirs: string[] = [];
function rollout(rows: object[]) {
  const dir = mkdtempSync(join(tmpdir(), "shahi-codex-index-"));
  dirs.push(dir);
  const path = join(dir, "rollout.jsonl");
  writeFileSync(path, lines(rows));
  return path;
}
const lines = (rows: object[]) => rows.map(row => JSON.stringify(row) + "\n").join("");
const event = (type: string, fields: object) => ({ type: "event_msg", payload: { type, ...fields } });
const response = (type: string, fields: object) => ({ type: "response_item", payload: { type, ...fields } });
const stats = (): CodexReadStats => ({ indexedBytes: 0, windowBytes: 0, parsedRows: 0 });
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("indexed pagination preserves parser IDs, reasoning coalescing and all supported record families", async () => {
  const rows = [
    { type: "session_meta" },
    event("user_message", { message: "hello مرحبا" }),
    event("agent_reasoning", { text: "first" }),
    { type: "turn_context" },
    event("agent_reasoning_raw_content", { text: "second" }),
    response("function_call", { name: "exec", call_id: "call", arguments: '{"cmd":"pwd"}' }),
    event("mcp_tool_call_end", { invocation: { server: "mcp", tool: "read", arguments: {} }, result: { Ok: { content: [{ text: "ok" }] } } }),
    event("patch_apply_end", { changes: { "a.ts": { type: "update" } }, stdout: "done", success: true }),
    event("web_search_end", { query: "query" }),
    event("item_completed", { item: { type: "AgentMessage", id: "item-id", content: [{ text: "reply" }] } }),
    response("custom_tool_call", { name: "exec", call_id: "custom", input: "hello" }),
    response("custom_tool_call_output", { call_id: "custom", output: [{ text: "custom output" }] }),
    event("agent_message", { message: "done" }),
    response("function_call_output", { call_id: "call", output: "distant output" }),
  ];
  const path = rollout(rows);
  const expected = normaliseCodex(rows);
  for (let before = 1; before <= expected.length; before++) {
    const actual = await readCodexWindow(path, { before, limit: 2 });
    expect(actual.messages).toEqual(expected.slice(Math.max(0, before - 2), before));
    expect(actual.total).toBe(expected.length);
  }
});

test("unchanged tail reads only the requested records, and appends index only new bytes", async () => {
  const rows = Array.from({ length: 1800 }, (_, n) => event("agent_message", { message: `${n}: ${"x".repeat(1000)}` }));
  const path = rollout(rows);
  await readCodexWindow(path, { limit: 12 });
  const quiet = stats();
  const tail = await readCodexWindow(path, { limit: 12, stats: quiet });
  expect(tail.messages).toEqual(normaliseCodex(rows).slice(-12));
  expect(quiet.indexedBytes).toBe(0);
  expect(quiet.parsedRows).toBe(12);
  expect(quiet.windowBytes).toBeLessThan(14000);
  const next = event("agent_message", { message: "next" });
  const added = lines([next]);
  appendFileSync(path, added);
  const update = stats();
  const result = await readCodexWindow(path, { limit: 1, stats: update });
  expect(update.indexedBytes).toBe(Buffer.byteLength(added));
  expect(update.parsedRows).toBe(2);
  expect(result.messages[0]?.id).toBe("codex-1800");
});

test("partial UTF-8 line resumes once complete; reasoning and distant tool results update", async () => {
  const rows = [response("function_call", { call_id: "pending", name: "exec" }), event("agent_reasoning", { text: "one" })];
  const path = rollout(rows);
  await readCodexWindow(path);
  const more = [event("agent_reasoning", { text: "مرحبا" }), response("function_call_output", { call_id: "pending", output: "returned" })];
  const data = Buffer.from(lines(more));
  const split = data.indexOf(Buffer.from("مرحبا")) + 1;
  appendFileSync(path, data.subarray(0, split));
  expect((await readCodexWindow(path)).messages).toEqual(normaliseCodex(rows));
  appendFileSync(path, data.subarray(split));
  expect((await readCodexWindow(path)).messages).toEqual(normaliseCodex([...rows, ...more]));
});

test("truncation, same-sized rewrite and file replacement discard old offsets", async () => {
  const path = rollout([event("agent_message", { message: "old" }), event("user_message", { message: "extra" })]);
  await readCodexWindow(path);
  for (const word of ["new", "two"]) {
    const rows = [event("agent_message", { message: word })];
    writeFileSync(path, lines(rows));
    expect((await readCodexWindow(path)).messages).toEqual(normaliseCodex(rows));
  }
  const replacement = [event("user_message", { message: "replacement" })];
  writeFileSync(path + ".new", lines(replacement));
  renameSync(path + ".new", path);
  expect((await readCodexWindow(path)).messages).toEqual(normaliseCodex(replacement));
});

test("concurrent reads index an append exactly once and malformed lines preserve IDs", async () => {
  const row = event("user_message", { message: "first" });
  const path = rollout([row]);
  await readCodexWindow(path);
  const added = event("agent_message", { message: "second" });
  appendFileSync(path, '\ninvalid json\n' + lines([added]));
  const logs = await Promise.all(Array.from({ length: 8 }, () => readCodexWindow(path)));
  for (const log of logs) expect(log.messages).toEqual(normaliseCodex([row, added]));
});

test("records crossing scan chunks keep byte offsets and capped distant output intact", async () => {
  const rows = [
    event("user_message", { message: "مرحبا".repeat(15000) }),
    response("function_call", { call_id: "large", name: "exec" }),
    event("agent_message", { message: "after" }),
    response("function_call_output", { call_id: "large", output: "z".repeat(150000) }),
  ];
  const path = rollout(rows);
  const expected = normaliseCodex(rows);
  expect((await readCodexWindow(path)).messages).toEqual(expected);
  expect((await readCodexWindow(path, { before: 2, limit: 1 })).messages).toEqual(expected.slice(1, 2));
});

test("the least recently used rollout index is evicted after 64 files", async () => {
  const first = rollout([event("user_message", { message: "evicted" })]);
  await readCodexWindow(first);
  for (let n = 0; n < 64; n++) {
    await readCodexWindow(rollout([event("agent_message", { message: String(n) })]));
  }
  const rebuilt = stats();
  expect((await readCodexWindow(first, { stats: rebuilt })).total).toBe(1);
  expect(rebuilt.indexedBytes).toBeGreaterThan(0);
});
