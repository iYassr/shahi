import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  antigravitySessionFromFiles, antigravitySessionFromPresence, antigravityTranscriptFor,
  antigravityUserText, findAntigravityTranscript, normaliseAntigravity, readAntigravityLog,
} from "./antigravity-log";
import type { HerdrClient } from "./herdr-client";
import { realPath } from "./real-path";

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OTHER = "11111111-2222-3333-4444-555555555555";
const DATE = "2026-09-27T06:26:06Z";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(id = SESSION) {
  const root = await mkdtemp(join(tmpdir(), "shahi-agy-log-")); roots.push(root);
  const directory = join(root, "brain", id, ".system_generated", "logs");
  await mkdir(directory, { recursive: true });
  return { root, path: join(directory, "transcript.jsonl") };
}
const user = (step: number, content = "Hello") => ({ step_index: step, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: DATE, content });
const agent = (step: number, content = "Done") => ({ step_index: step, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: DATE, content });
const call = (step: number, name = "run_command", args: Record<string, unknown> = { CommandLine: '"printf MARKER"' }) => ({ ...agent(step, ""), tool_calls: [{ name, args }] });
const result = (step: number, content = "MARKER", status = "DONE") => ({ step_index: step, source: "MODEL", type: "GENERIC", status, created_at: DATE, content });
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row) + "\n").join("");

test("finds only the exact documented session path, never the latest folder cache", async () => {
  const { root, path } = await fixture(); await writeFile(path, jsonl([user(0)]));
  expect(await findAntigravityTranscript(SESSION, root)).toBe(await realPath(path));
  expect(await findAntigravityTranscript(OTHER, root)).toBeNull();
  expect(await findAntigravityTranscript("../../" + SESSION, root)).toBeNull();
  expect(await findAntigravityTranscript("codex:" + SESSION, root)).toBeNull();
  expect(await findAntigravityTranscript("", root)).toBeNull();
});

test("refuses a transcript symlink to another session even inside the transcript root", async () => {
  const { root, path } = await fixture();
  const otherDir = join(root, "brain", OTHER, ".system_generated", "logs"); await mkdir(otherDir, { recursive: true });
  const otherPath = join(otherDir, "transcript.jsonl"); await writeFile(otherPath, jsonl([user(0, "Other session")]));
  await symlink(otherPath, path);
  expect(await findAntigravityTranscript(SESSION, root)).toBeNull();
});

test("refuses a transcript symlink outside the transcript root", async () => {
  const { root, path } = await fixture(); const outside = join(root, "outside.jsonl");
  await writeFile(outside, jsonl([user(0)])); await symlink(outside, path);
  expect(await findAntigravityTranscript(SESSION, root)).toBeNull();
});

test("binds the exact presence lock, never a database or similarly named root", () => {
  const root = "/home/test/.gemini/antigravity-cli";
  expect(antigravitySessionFromPresence(`${root}/presence/${SESSION}.lock`, root)).toBe(SESSION);
  for (const path of [`${root}/conversations/${SESSION}.db`, `${root}/presence/${SESSION}.lock-wal`, `${root}-other/presence/${SESSION}.lock`, `${root}/presence/child/${SESSION}.lock`]) {
    expect(antigravitySessionFromPresence(path, root)).toBeNull();
  }
});

test("duplicate descriptors are one session; multiple sessions remain ambiguous", () => {
  const root = "/root/agy"; const a = `${root}/presence/${SESSION}.lock`; const b = `${root}/presence/${OTHER}.lock`;
  expect(antigravitySessionFromFiles([a, a], root)).toBe(SESSION);
  expect(antigravitySessionFromFiles([a, b], root)).toBeNull();
  expect(antigravitySessionFromFiles([], root)).toBeNull();
});

test("an explicit invalid or unavailable reported session never falls back to a different process", async () => {
  let calls = 0;
  const client = { rpc: async () => { calls++; throw new Error("Should not inspect processes"); } } as unknown as HerdrClient;
  expect(await antigravityTranscriptFor(client, "w1:p1", `claude:${SESSION}`)).toBeNull();
  expect(await antigravityTranscriptFor(client, "w1:p1", SESSION)).toBeNull();
  expect(calls).toBe(0);
});

test("missing or non-Antigravity foreground processes do not bind another provider's files", async () => {
  const client = { rpc: async () => ({ process_info: { foreground_processes: [{ pid: process.pid, name: "codex" }] } }) } as unknown as HerdrClient;
  expect(await antigravityTranscriptFor(client, "w1:p1")).toBeNull();
});

test("only the authored user request is visible, without timestamps or settings instructions", () => {
  expect(antigravityUserText("<USER_REQUEST>\nRead fixture.txt\n</USER_REQUEST>\n<ADDITIONAL_METADATA>Private context</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>Settings</USER_SETTINGS_CHANGE>")).toBe("Read fixture.txt");
  expect(antigravityUserText(" Plain input ")).toBe("Plain input");
  expect(antigravityUserText("<UNKNOWN_ENVELOPE>context</UNKNOWN_ENVELOPE>")).toBe("");
});

test("renders authored prose and thinking with stable step IDs and real timestamps", () => {
  expect(normaliseAntigravity([user(0), { ...agent(3), thinking: "Considering the fixture" }])).toEqual([
    { id: "agy-0", role: "you", at: Date.parse(DATE), blocks: [{ kind: "text", text: "Hello" }] },
    { id: "agy-3", role: "agent", at: Date.parse(DATE), blocks: [{ kind: "thinking", text: "Considering the fixture" }, { kind: "text", text: "Done" }] },
  ]);
});

test("decodes JSON-encoded arguments and pairs the adjacent tool output", () => {
  const messages = normaliseAntigravity([call(1), result(2)]);
  expect(messages).toHaveLength(1);
  expect(messages[0]!.blocks[0]).toEqual({ kind: "tool", name: "run_command", summary: "printf MARKER", result: { text: "MARKER", isError: false, truncated: false, images: [] } });
});

test("keeps read/edit paths and recorded edit diffs", () => {
  const messages = normaliseAntigravity([call(1, "replace_file_content", { TargetFile: '"/workspace/file.txt"', ReplacementContent: '"new text"' }), result(2, "@@ -1 +1 @@\n-old\n+new text")]);
  expect(messages[0]!.blocks[0]).toMatchObject({ name: "replace_file_content", summary: "/workspace/file.txt", file: { path: "/workspace/file.txt", name: "file.txt" }, result: { text: "@@ -1 +1 @@\n-old\n+new text" } });
  expect(normaliseAntigravity([call(1, "view_file", { AbsolutePath: '"relative.txt"' })])[0]!.blocks[0]).not.toHaveProperty("file");
});

test("records denied or failed tools as errors, including errors without content", () => {
  const messages = normaliseAntigravity([call(1), { ...result(2, "", "ERROR"), error: "User denied permission" }]);
  expect(messages[0]!.blocks[0]).toMatchObject({ result: { text: "User denied permission", isError: true } });
});

test("does not pair missing, out-of-order, unknown-source or multi-call results", () => {
  for (const later of [result(3), { ...result(2), source: "SYSTEM" }, { ...result(2), type: "NEW_TYPE" }]) {
    expect(normaliseAntigravity([call(1), later])[0]!.blocks[0]).toMatchObject({ result: null });
  }
  const multiple = { ...call(1), tool_calls: [{ name: "first", args: {} }, { name: "second", args: {} }] };
  expect(normaliseAntigravity([multiple, result(2)])[0]!.blocks).toEqual([
    { kind: "tool", name: "first", summary: "", result: null, outputUnavailable: true },
    { kind: "tool", name: "second", summary: "", result: null, outputUnavailable: true },
  ]);
  expect(normaliseAntigravity([result(2)])).toEqual([]);
});

test("empty completed results finish the tool and running results remain live", () => {
  expect(normaliseAntigravity([call(1), result(2, "")])[0]!.blocks[0]).toMatchObject({ result: { text: "", isError: false } });
  expect(normaliseAntigravity([call(1), result(2, "", "RUNNING")])[0]!.blocks[0]).toMatchObject({ result: null });
});

test("supports documented question choices encoded inside tool arguments", () => {
  const questions = [{ question: "Which colour?", options: ["Blue", "Green"], is_multi_select: false }];
  expect(normaliseAntigravity([call(1, "ask_question", { questions: JSON.stringify(questions) })])[0]!.blocks[0]).toMatchObject({ questions: [{ text: "Which colour?", options: [{ label: "Blue" }, { label: "Green" }] }] });
});

test("keeps pages bounded and reports provider-side truncation", () => {
  const messages = normaliseAntigravity([{ ...call(1), truncated_fields: ["tool_calls"] }, { ...result(2, "x".repeat(3_000)), truncated_fields: ["content"] }]);
  expect(messages[0]!.blocks[0]).toMatchObject({ outputUnavailable: true, result: null });
  const intact = normaliseAntigravity([call(1), { ...result(2, "x".repeat(3_000)), truncated_fields: ["content"] }]);
  expect(intact[0]!.blocks[0]).toMatchObject({ result: { text: "x".repeat(2_000) + "\n…", truncated: true } });
  expect(messages[0]!.blocks[1]).toEqual({ kind: "text", text: "Antigravity truncated this part of the saved transcript." });
});

test("drops internal context, checkpoints, implicit inputs and unknown/malformed shapes", () => {
  const rows = [null, [], 42, { ...user(0), source: "SYSTEM" }, { ...agent(1), type: "SYSTEM_MESSAGE" }, { ...agent(2), type: "CHECKPOINT" }, { ...agent(3), step_index: -1 }, { ...agent(4), step_index: "4" }, { ...agent(5), content: {}, thinking: [], tool_calls: [null, { name: 4 }] }];
  expect(normaliseAntigravity(rows as Record<string, unknown>[])).toEqual([]);
});

test("pages preserve paired results, total counts and transcript-scoped IDs", async () => {
  const { path } = await fixture();
  await writeFile(path, jsonl([user(0), call(1), result(2), agent(3), user(4, "Second"), agent(5, "Answer")]));
  const tail = await readAntigravityLog(path, { limit: 2 });
  expect(tail).toMatchObject({ sessionId: SESSION, total: 5 });
  expect(tail!.messages.map(message => message.id)).toEqual([expect.stringMatching(new RegExp(`^${SESSION}:.*:agy-4$`)), expect.stringMatching(new RegExp(`^${SESSION}:.*:agy-5$`))]);
  const early = await readAntigravityLog(path, { limit: 2, before: 3 });
  expect(early!.messages.map(message => message.id)).toEqual([expect.stringMatching(new RegExp(`^${SESSION}:.*:agy-1$`)), expect.stringMatching(new RegExp(`^${SESSION}:.*:agy-3$`))]);
  expect(early!.messages[0]!.blocks[0]).toMatchObject({ result: { text: "MARKER" } });
});

test("new sessions never reuse IDs and append/rewrite refreshes the same session", async () => {
  const first = await fixture(); const second = await fixture(OTHER);
  await writeFile(first.path, jsonl([user(0, "First")])); await writeFile(second.path, jsonl([user(0, "Other")]));
  const a = await readAntigravityLog(first.path); const b = await readAntigravityLog(second.path);
  expect(a!.messages[0]!.id).not.toBe(b!.messages[0]!.id);
  await appendFile(first.path, jsonl([agent(1, "First answer")]));
  expect((await readAntigravityLog(first.path))!.total).toBe(2);
  await writeFile(first.path, jsonl([user(0, "Reset")]));
  const reset = await readAntigravityLog(first.path);
  expect(reset!.total).toBe(1); expect(reset!.messages[0]!.blocks).toEqual([{ kind: "text", text: "Reset" }]);
});

test("a partial final JSONL record waits for completion", async () => {
  const { path } = await fixture();
  const complete = jsonl([user(0)]); const later = JSON.stringify(agent(1));
  await writeFile(path, complete + later.slice(0, 30));
  expect((await readAntigravityLog(path))!.total).toBe(1);
  await appendFile(path, later.slice(30) + "\n");
  expect((await readAntigravityLog(path))!.total).toBe(2);
});


test("tool-result truncation never leaves half a Unicode surrogate", () => {
  const messages = normaliseAntigravity([call(1), result(2, "x".repeat(1_999) + "😀tail")]);
  expect(messages[0]!.blocks[0]).toMatchObject({ result: { text: "x".repeat(1_999) + "\n…", truncated: true } });
});

test("huge tool metadata and question lists stay bounded without fake file paths or completion", () => {
  const questions = Array.from({ length: 20 }, () => ({ question: "Q".repeat(5_000), options: Array.from({ length: 30 }, () => ({ label: "L".repeat(1_000), description: "D".repeat(2_000) })) }));
  const messages = normaliseAntigravity([{ ...agent(1, ""), tool_calls: [
    { name: "N".repeat(10_000), args: { TargetFile: JSON.stringify("/" + "F".repeat(10_000)) } },
    { name: "ask_question", args: { questions: JSON.stringify(questions) } },
  ] }]);
  const tool = messages[0]!.blocks[0]!;
  const question = messages[0]!.blocks[1]!;
  expect(tool).not.toHaveProperty("file");
  expect(tool).toMatchObject({ name: "N".repeat(200) + "…", result: null, outputUnavailable: true });
  expect(question.kind === "tool" && question.questions).toHaveLength(8);
  if (question.kind !== "tool") throw new Error("Missing tool");
  expect(question.questions![0]!.text).toHaveLength(1025);
  expect(question.questions![0]!.options).toHaveLength(16);
  expect(question.questions![0]!.options[0]!.label).toHaveLength(129);
  expect(question.questions![0]!.options[0]!.description).toHaveLength(257);
  expect(JSON.stringify(messages).length).toBeLessThan(80_000);
  expect(messages[0]!.blocks.at(-1)).toMatchObject({ kind: "text", text: expect.stringContaining("Reader limit") });
});

test("bounds tool counts and bytes before handing a message to the client", () => {
  const questions = [{ question: "Q".repeat(1_000), options: Array.from({ length: 16 }, () => "L".repeat(128)) }];
  const rows = [{ ...agent(1, ""), tool_calls: Array.from({ length: 1_000 }, () => ({ name: "ask_question", args: { questions: JSON.stringify(questions) } })) }];
  const messages = normaliseAntigravity(rows);
  expect(messages[0]!.blocks.length).toBeLessThan(258);
  expect(Buffer.byteLength(JSON.stringify(messages))).toBeLessThan(400 * 1024);
  expect(messages[0]!.blocks.at(-1)).toMatchObject({ text: expect.stringContaining("Reader limit") });
  for (const block of messages[0]!.blocks) if (block.kind === "tool") expect(block).toMatchObject({ result: null, outputUnavailable: true });
});


test("same-session rewind invalidates retained history even when the final bytes are unchanged", async () => {
  const { path } = await fixture();
  const suffix = agent(9, "This final response remains unchanged across the rewrite and is longer than sixty-four bytes.");
  await writeFile(path, jsonl([user(0, "First request"), agent(1, "Discard this turn"), suffix]));
  const first = await readAntigravityLog(path);
  // A longer middle rewrite retains the tail anchor and can still reuse IDs.
  // Without prefix verification the old index would keep offsets into new rows.
  await writeFile(path, jsonl([user(0, "Replacement request with a deliberately longer body"), { ...agent(1, "Internal rewind metadata"), type: "SYSTEM_MESSAGE", source: "SYSTEM" }, suffix]));
  const rewritten = await readAntigravityLog(path);
  expect(rewritten!.sessionId).toBe(first!.sessionId);
  expect(rewritten!.path).not.toBe(first!.path);
  expect(rewritten!.total).toBe(2);
  expect(rewritten!.messages.map(message => message.blocks[0])).toEqual([{ kind: "text", text: "Replacement request with a deliberately longer body" }, { kind: "text", text: suffix.content }]);
  expect(rewritten!.messages[0]!.id).not.toBe(first!.messages[0]!.id);
  await appendFile(path, jsonl([user(10, "Continue")]));
  const appended = await readAntigravityLog(path);
  expect(appended!.path).toBe(rewritten!.path);
  expect(appended!.messages[0]!.id).toBe(rewritten!.messages[0]!.id);
});
