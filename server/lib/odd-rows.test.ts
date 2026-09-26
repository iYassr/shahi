/**
 * Transcript rows of a shape nobody wrote a reader for.
 *
 * The readers promise that an unknown shape is dropped, never guessed at. The
 * pre-release bug hunt found that a row with a familiar type but an
 * unfamiliar field type did worse than either: a codex `agent_message` whose
 * message was a list, a bare `null` line, or thinking given as an object
 * threw inside the normaliser. The codex index then gave up on the whole
 * rollout on every read, so the pane had no conversation at all, and the
 * Claude and Cursor readers answered 500 for every page covering the row.
 *
 * So every field of every shape the normalisers read is replaced, one at a
 * time, by every kind of JSON value, and the result must be a well-formed
 * conversation with no invented text in it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogMessage } from "@shahi/shared";
import { normaliseCodex, readCodexWindow, type CodexReadStats } from "./codex-log";
import { normaliseCursor, readCursorLog } from "./cursor-log";
import { normalise, readWindow } from "./session-log";

const dir = mkdtempSync(join(tmpdir(), "shahi-odd-rows-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;
const file = (rows: unknown[]) => {
  const path = join(dir, `${files++}.jsonl`);
  writeFileSync(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
  return path;
};

/** One of each kind of JSON value, and the objects a careless reader turns into text. */
const ODD: unknown[] = [null, 0, -1, 1.5, true, "", "text", [], [null], [1, "x"], {}, { text: {} }, { type: {} }];

/** Copies of `value` with exactly one position replaced by an odd value: the whole, each field, each element. */
function* variants(value: unknown): Generator<unknown> {
  yield* ODD;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      for (const odd of variants(item)) yield value.map((original, at) => (at === index ? odd : original));
    }
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      for (const odd of variants(item)) yield { ...value, [key]: odd };
    }
  }
}

/** The wire shape the clients rely on, and nothing a reader made up from a value it did not understand. */
function expectWellFormed(messages: LogMessage[]) {
  for (const message of messages) {
    expect(typeof message.id).toBe("string");
    expect(["you", "agent", "system"]).toContain(message.role);
    expect(Number.isFinite(message.at)).toBe(true);
    for (const block of message.blocks) {
      for (const key of ["text", "name", "summary", "mediaType", "ref"] as const) {
        const value = (block as Record<string, unknown>)[key];
        if (value !== undefined) expect(typeof value).toBe("string");
      }
      if (block.kind === "tool" && block.result) expect(typeof block.result.text).toBe("string");
    }
  }
  expect(JSON.stringify(messages)).not.toMatch(/\[object Object\]|undefined|NaN/);
}

const claudeShapes = [
  { type: "user", uuid: "u1", timestamp: "2026-09-20T01:00:00Z", message: { role: "user", content: "a question" } },
  { type: "user", uuid: "u2", timestamp: "2026-09-20T01:00:01Z", message: { content: [{ type: "text", text: "typed" }, { type: "image", source: { media_type: "image/png", data: "AA==" } }] } },
  {
    type: "assistant", uuid: "a1", timestamp: "2026-09-20T01:00:02Z",
    message: { content: [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "said" },
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/tmp/x.txt" } },
      { type: "tool_use", id: "t2", name: "AskUserQuestion", input: { questions: [{ question: "Which?", options: [{ label: "A", description: "first" }] }] } },
      { type: "fallback", to: { model: "claude-opus" } },
    ] },
  },
  {
    type: "user", uuid: "u3", timestamp: "2026-09-20T01:00:03Z",
    message: { content: [
      { type: "tool_result", tool_use_id: "t1", content: "the file", is_error: false },
      { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "answered" }, { type: "image", source: { media_type: "image/png" } }] },
    ] },
  },
  { type: "system", subtype: "away_summary", uuid: "s1", timestamp: "2026-09-20T01:00:04Z", content: "while you were away" },
];

const codexShapes = [
  { timestamp: "2026-09-20T01:00:00Z", type: "event_msg", payload: { type: "user_message", message: "hello" } },
  { type: "event_msg", payload: { type: "agent_message", message: "reply" } },
  { type: "event_msg", payload: { type: "agent_reasoning", text: "thinking" } },
  { type: "event_msg", payload: { type: "mcp_tool_call_end", invocation: { server: "s", tool: "t", arguments: { title: "x" } }, result: { Ok: { content: [{ text: "ok" }] } } } },
  { type: "event_msg", payload: { type: "patch_apply_end", changes: { "/r/a.ts": { type: "update" } }, stdout: "done", stderr: "", success: true } },
  { type: "event_msg", payload: { type: "web_search_end", query: "q" } },
  { type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "go" }] } } },
  { type: "event_msg", payload: { type: "item_completed", item: { type: "Reasoning", summary_text: ["first"], raw_content: ["raw"] } } },
  { type: "event_msg", payload: { type: "item_completed", item: { type: "McpToolCall", server: "s", tool: "t", arguments: { path: "/a" }, status: "failed", result: { content: [{ text: "no" }], isError: true } } } },
  { type: "event_msg", payload: { type: "item_completed", item: { type: "FileChange", changes: { "/r/b.ts": { type: "add" } }, stdout: "ok", status: "completed" } } },
  { type: "event_msg", payload: { type: "item_completed", item: { type: "WebSearch", query: "w" } } },
  { type: "response_item", payload: { type: "function_call", name: "shell", call_id: "c1", arguments: '{"command":"ls"}' } },
  { type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "a.txt" } },
  { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "c2", input: 'tools.exec_command({"cmd":"pwd"})' } },
  { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c2", output: [{ type: "input_text", text: "/r" }] } },
];

const cursorShapes = [
  { role: "user", message: { content: [{ type: "text", text: "<user_query>fix it</user_query>" }] } },
  { role: "assistant", message: { content: [{ type: "thinking", thinking: "plan" }, { type: "text", text: "done" }, { type: "tool_use", name: "Read", input: { path: "/tmp/a" } }] } },
];

describe("every field of every shape, given every kind of value", () => {
  const cases = [
    { reader: "Claude", shapes: claudeShapes, normaliser: (rows: unknown[]) => normalise(rows as Record<string, unknown>[]) },
    { reader: "codex", shapes: codexShapes, normaliser: (rows: unknown[]) => normaliseCodex(rows as Record<string, unknown>[]) },
    { reader: "Cursor", shapes: cursorShapes, normaliser: (rows: unknown[]) => normaliseCursor(rows as Record<string, unknown>[]) },
  ];
  for (const { reader, shapes, normaliser } of cases) {
    test(`the ${reader} normaliser drops what it does not understand instead of throwing or inventing text`, () => {
      expectWellFormed(normaliser(shapes));
      for (const [index, shape] of shapes.entries()) {
        for (const odd of variants(shape)) {
          const rows = shapes.map((row, at) => (at === index ? odd : row));
          let messages: LogMessage[] = [];
          expect(() => { messages = normaliser(rows); }).not.toThrow();
          expectWellFormed(messages);
        }
      }
    });
  }
});

// The rows the bug hunt reported, among ordinary ones.
const plain = (n: number) => ({ type: "event_msg", payload: { type: "agent_message", message: `message ${n}` } });
const oddCodex = [
  null,
  { type: "event_msg", payload: { type: "agent_message", message: [{ type: "text", text: "structured" }] } },
  { type: "event_msg", payload: { type: "agent_reasoning", text: { summary: "an object" } } },
  { type: "event_msg", payload: { type: "user_message", message: 42 } },
  { type: "response_item", payload: { type: "function_call_output", call_id: "x", output: [{ text: { nested: true } }] } },
];

test("one malformed rollout row does not hide the codex conversation, or cost a full re-read on every poll", async () => {
  const rows = [plain(0), plain(1), ...oddCodex, ...Array.from({ length: 10 }, (_, n) => plain(n + 2))];
  const path = file(rows);
  const whole = normaliseCodex(rows.filter((row) => row !== null) as Record<string, unknown>[]);
  expect(whole.map((m) => m.blocks[0])).toEqual(Array.from({ length: 12 }, (_, n) => ({ kind: "text", text: `message ${n}` })));
  const first = await readCodexWindow(path, { limit: 60 });
  expect(first.total).toBe(12);
  expect(first.messages.map((m) => m.blocks[0])).toEqual(whole.map((m) => m.blocks[0]));
  // The index is kept: a second poll of an unchanged rollout reads no bytes to index.
  const again: CodexReadStats = { indexedBytes: 0, windowBytes: 0, parsedRows: 0 };
  expect((await readCodexWindow(path, { limit: 2, stats: again })).messages.map((m) => m.blocks[0])).toEqual(whole.slice(-2).map((m) => m.blocks[0]));
  expect(again.indexedBytes).toBe(0);
});

const said = (n: number) => ({ type: "assistant", uuid: `a${n}`, timestamp: "2026-09-20T01:00:00Z", message: { content: [{ type: "text", text: `message ${n}` }] } });
const oddClaude = [
  null,
  7,
  "a string",
  { type: "user", uuid: "odd1", message: { content: [null] } },
  { type: "assistant", uuid: "odd2", message: { content: [{ type: "thinking", thinking: { text: "an object" } }] } },
  { type: "assistant", uuid: "odd3", message: { content: [{ type: "text", text: 12 }] } },
  { type: "user", uuid: "odd4", message: { content: [{ type: "tool_result", tool_use_id: "t", content: [null, { type: "text", text: {} }] }] } },
];

test("one oddly shaped Claude row does not fail the page that covers it", async () => {
  const rows = [said(0), said(1), ...oddClaude, said(2), said(3)];
  const path = file(rows);
  const expected = [0, 1, 2, 3].map((n) => ({ kind: "text" as const, text: `message ${n}` }));
  for (const limit of [60, 2, 1]) {
    const page = await readWindow(path, { limit });
    expect(page!.total).toBe(4);
    expect(page!.messages.map((m) => m.blocks[0])).toEqual(expected.slice(-limit));
  }
  expect((await readWindow(path, { limit: 2, before: 2 }))!.messages.map((m) => m.blocks[0])).toEqual(expected.slice(0, 2));
});

test("one oddly shaped Cursor row does not fail the page that covers it", async () => {
  const typed = (text: string) => ({ role: "user", message: { content: [{ type: "text", text }] } });
  const rows = [
    typed("first"),
    null,
    { role: "assistant", message: { content: [{ type: "thinking", thinking: { text: "an object" } }] } },
    { role: "assistant", message: { content: [{ type: "text", text: { nested: true } }] } },
    typed("last"),
  ];
  const path = file(rows);
  for (const limit of [60, 1]) {
    const page = await readCursorLog(path, { limit });
    expect(page!.total).toBe(2);
    expect(page!.messages.map((m) => m.blocks[0])).toEqual([{ kind: "text" as const, text: "first" }, { kind: "text" as const, text: "last" }].slice(-limit));
  }
});

// The Claude index has always skipped a row its normaliser throws on, but the
// page read the same bytes again and handed every row to one normaliser call,
// so that row answered 500 for every page that covered it (pre-release bug
// hunt). The normalisers no longer throw on any shape above; this holds the
// page to the index's rule for whatever one might throw on next.
test("a row the normaliser throws on costs that row in the page, not the page", async () => {
  const rows = [said(0), said(1), { ...said(9), uuid: "unreadable" }, said(2), said(3)];
  const path = file(rows);
  const fussy = (batch: Record<string, unknown>[]) => {
    if (batch.some((row) => row.uuid === "unreadable")) throw new TypeError("a shape this normaliser cannot read");
    return normalise(batch);
  };
  const expected = [0, 1, 2, 3].map((n) => ({ kind: "text" as const, text: `message ${n}` }));
  for (const limit of [60, 3]) {
    const page = await readWindow(path, { limit }, fussy);
    expect(page!.total).toBe(4);
    expect(page!.messages.map((m) => m.blocks[0])).toEqual(expected.slice(-limit));
  }
});
