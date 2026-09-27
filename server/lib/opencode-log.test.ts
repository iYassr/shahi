import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findOpenCodeTranscript, normaliseOpenCode, openCodeStamp, readOpenCodeImage, readOpenCodeLog, type OpenCodeTranscript } from "./opencode-log";
import { createOpenCodeFixture, openCodeFixtureMessage, OPEN_CODE_SESSION as sid } from "./opencode-log-fixtures";
import type { Database } from "bun:sqlite";

const roots: string[] = [], handles: Database[] = [];
afterEach(async () => { for (const db of handles.splice(0)) db.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "shahi-opencode-test-")); roots.push(root);
  const path = join(root, "opencode.db"), db = createOpenCodeFixture(path); handles.push(db);
  return { db, path, source: { kind: "opencode", databasePath: path, sessionId: sid } as OpenCodeTranscript };
}
const row = (role: string, parts: Record<string, unknown>[], extra = {}) => ({ info: { id: "msg_fixture", sessionID: sid, role, time: { created: 1234 }, ...extra }, parts: parts.map((p, i) => ({ id: `prt_${i}`, messageID: "msg_fixture", sessionID: sid, ...p })) });
const texts = (log: Awaited<ReturnType<typeof readOpenCodeLog>>) => log?.messages.flatMap(m => m.blocks.flatMap(b => b.kind === "text" ? [b.text] : []));

describe("OpenCode messages and parts", () => {
  test("renders user prose and attachments without synthetic model context", () => {
    const result = normaliseOpenCode([row("user", [
      { type: "text", text: "Read the screenshot" }, { type: "text", text: "secret context", synthetic: true },
      { type: "text", text: "ignored", ignored: true }, { type: "file", mime: "image/png", url: "data:image/png;base64,eA==" },
      { type: "file", mime: "text/plain", filename: "notes.txt", url: "file:///tmp/notes.txt" },
      { type: "agent", name: "explore" }, { type: "unknown", text: "never" },
    ])], sid);
    expect(result[0]?.role).toBe("you"); expect(result[0]?.at).toBe(1234);
    expect(result[0]?.id).toBe(`${sid}:msg_fixture`);
    expect(result[0]?.blocks.map(b => b.kind)).toEqual(["text", "image", "tool", "text"]);
    expect(JSON.stringify(result)).not.toContain("secret context"); expect(JSON.stringify(result)).not.toContain("eA==");
  });
  test("renders reasoning, pending/completed/failed tools, diffs, MCP and questions", () => {
    const result = normaliseOpenCode([row("assistant", [
      { type: "reasoning", text: "Consider the result" },
      { type: "tool", tool: "bash", state: { status: "running", input: { command: "pwd" } } },
      { type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "/tmp/file.ts" }, output: "Applied", metadata: { diff: "-old\n+new" } } },
      { type: "tool", tool: "mcp_search", state: { status: "error", input: { query: "item" }, error: "Permission denied" } },
      { type: "tool", tool: "question", state: { status: "completed", input: { questions: [{ question: "Which?", options: [{ label: "One", description: "first" }] }] }, output: "One" } },
      { type: "text", text: "Done" },
    ])], sid)[0]!;
    expect(result.role).toBe("agent");
    const tools = result.blocks.filter(b => b.kind === "tool");
    expect(tools[0]?.result).toBeNull(); expect(tools[1]?.file?.path).toBe("/tmp/file.ts");
    expect(tools[1]?.result?.text).toBe("Applied\n\n-old\n+new"); expect(tools[2]?.result?.isError).toBe(true);
    expect(tools[3]?.questions?.[0]?.options[0]?.label).toBe("One");
  });
  test("renders errors, compaction and retries as system events, not user prose", () => {
    expect(normaliseOpenCode([row("user", [{ type: "compaction", auto: true }])], sid)[0]?.role).toBe("system");
    const error = { name: "APIError", data: { message: "Rate limit", responseHeaders: { Authorization: "never render" } } };
    const result = normaliseOpenCode([row("assistant", [{ type: "retry", attempt: 2, error }], { error })], sid);
    expect(result[0]?.role).toBe("system"); expect(JSON.stringify(result)).toContain("Rate limit"); expect(JSON.stringify(result)).not.toContain("Authorization");
    const compact = normaliseOpenCode([row("assistant", [{ type: "tool", tool: "bash", state: { status: "completed", input: {}, output: "Old private output", time: { compacted: 8 } } }])], sid);
    expect(JSON.stringify(compact)).not.toContain("Old private output");
    expect(compact[0]?.blocks[0]).toMatchObject({ outputUnavailable: true });
  });
  test("drops malformed records and foreign session/part ownership", () => {
    const good = row("assistant", [{ type: "text", text: "Only ours" }]);
    expect(normaliseOpenCode([null, 42, {}, { ...good, info: { ...good.info, sessionID: "ses_other" } }, { ...good, parts: [{ ...good.parts[0], messageID: "msg_other" }] }, good], sid)).toHaveLength(1);
  });
  test("bounds a single huge message including tool/question fields in encoded bytes", () => {
    const parts = Array.from({ length: 50 }, () => ({ type: "text", text: "😀".repeat(100_000) }));
    const log = normaliseOpenCode([row("assistant", parts)], sid);
    expect(Buffer.byteLength(JSON.stringify(log))).toBeLessThan(400 * 1024);
    expect(JSON.stringify(log)).toContain("exceeds the Reader limit");
    const questions = [{ question: "Q".repeat(10_000), options: Array.from({ length: 80 }, () => ({ label: "L".repeat(1000), description: "D".repeat(5000) })) }];
    const tool = normaliseOpenCode([row("assistant", [{ type: "tool", tool: "question", state: { status: "completed", input: { questions }, output: "ok" } }])], sid);
    expect(Buffer.byteLength(JSON.stringify(tool))).toBeLessThan(30_000);
  });
});

describe("OpenCode read-only SQLite windows", () => {
  test("selects only an exact valid session, never the newest in the same database", async () => {
    const { db, path } = await fixture();
    db.run("INSERT INTO session(id) VALUES ('ses_other')");
    openCodeFixtureMessage(db, "msg_other", "user", 9000, [{ type: "text", text: "foreign" }], "ses_other");
    expect(await findOpenCodeTranscript("../ses_other", path)).toBeNull();
    expect(await findOpenCodeTranscript("ses_missing", path)).toBeNull();
    const source = await findOpenCodeTranscript(sid, path);
    expect(source?.sessionId).toBe(sid); expect((await readOpenCodeLog(source!))?.total).toBe(0);
    expect(await findOpenCodeTranscript(sid, join(path, "missing"))).toBeNull();
  });
  test("a tail of synthetic/unknown/empty rows cannot trap API 5 pagination", async () => {
    const { db, source } = await fixture();
    openCodeFixtureMessage(db, "msg_visible", "user", 0, [{ type: "text", text: "Earlier visible message" }]);
    for (let i = 0; i < 70; i++) openCodeFixtureMessage(db, `msg_synthetic${i}`, "user", i + 1, [
      { type: "text", text: "Hidden instructions", synthetic: true }, { type: "unknown", text: "Never render" },
      { type: "text", text: "\t \n\u2003\ufeff" }, { type: "text", text: 42 }, { type: "file", filename: "unknown-without-required-MIME" },
    ]);
    const tail = await readOpenCodeLog(source, { limit: 60 });
    expect(tail?.total).toBe(1); expect(tail?.messages).toHaveLength(1); expect(texts(tail)).toEqual(["Earlier visible message"]);
    expect((tail!.total - tail!.messages.length)).toBe(0);
  });
  test("client-style history paging visits every visible message once across hidden rows", async () => {
    const { db, source } = await fixture();
    for (let i = 0; i < 30; i++) openCodeFixtureMessage(db, `msg_${String(i).padStart(2, "0")}`, "assistant", i, [
      i % 3 === 0 ? { type: "text", text: `Visible ${i}` } : { type: "text", text: "Hidden", ignored: true },
    ]);
    const seen: string[] = []; let before: number | undefined;
    do {
      const page = (await readOpenCodeLog(source, { limit: 3, before }))!;
      expect(page.total).toBe(10); expect(page.messages.length).toBeGreaterThan(0);
      seen.unshift(...page.messages.map(m => m.id));
      // Existing mobile/web callers advance by rendered count, not log.offset.
      before = (before ?? page.total) - page.messages.length;
    } while (before > 0);
    expect(seen).toHaveLength(10); expect(new Set(seen).size).toBe(10);
    expect(seen[0]).toBe(`${sid}:msg_00`); expect(seen.at(-1)).toBe(`${sid}:msg_27`);
  });
  test("bounded projections retain visible messages with huge hidden metadata or whitespace prefixes", async () => {
    const { db, source } = await fixture();
    openCodeFixtureMessage(db, "msg_metadata", "user", 0, [{ type: "text", text: "Real prompt" }], sid, { system: "x".repeat(200_000) });
    openCodeFixtureMessage(db, "msg_space", "assistant", 1, [{ type: "text", text: " ".repeat(70_000) + "Visible tail" }]);
    openCodeFixtureMessage(db, "msg_think", "assistant", 2, [{ type: "reasoning", text: "\u2003".repeat(70_000) + "Reasoning tail" }]);
    openCodeFixtureMessage(db, "msg_error", "assistant", 3, [], sid, { error: { name: "APIError", data: { message: "Error only", responseBody: "x".repeat(200_000) } } });
    openCodeFixtureMessage(db, "msg_nul", "assistant", 4, [{ type: "text", text: "\0binary-shaped" }]);
    const log = (await readOpenCodeLog(source))!;
    expect(log.total).toBe(4); expect(log.messages).toHaveLength(4);
    expect(log.messages[0]?.blocks[0]).toEqual({ kind: "text", text: "Real prompt" });
    expect(JSON.stringify(log.messages[1])).toContain("Reader excerpt"); expect(JSON.stringify(log.messages[2])).toContain("Reader excerpt");
    expect(log.messages[3]?.blocks[0]).toEqual({ kind: "text", text: "Error only" });
    expect(Buffer.byteLength(JSON.stringify(log))).toBeLessThan(400 * 1024);
  });
  test("an initially empty streaming message enters the visible count when text arrives", async () => {
    const { db, source } = await fixture();
    openCodeFixtureMessage(db, "msg_stream", "assistant", 1, [{ type: "reasoning", text: "" }]);
    expect((await readOpenCodeLog(source))?.total).toBe(0);
    db.run("UPDATE part SET data=? WHERE id='prt_stream_0'", [JSON.stringify({ type: "reasoning", text: "Now visible" })]);
    const log = await readOpenCodeLog(source); expect(log?.total).toBe(1); expect(log?.messages).toHaveLength(1);
  });
  test("NUL-damaged IDs are not counted and NUL URLs cannot manufacture file paths", async () => {
    const { db, source } = await fixture();
    openCodeFixtureMessage(db, "msg_bad\0suffix", "user", 0, [{ id: "prt_good", type: "text", text: "Damaged message ID" }]);
    openCodeFixtureMessage(db, "msg_badpart", "user", 1, [{ id: "prt_bad\0suffix", type: "text", text: "Damaged part ID" }]);
    openCodeFixtureMessage(db, "msg_files", "user", 2, [
      { type: "file", mime: "text/plain", url: "file:///tmp/incorrect.txt\0suffix" },
      { type: "file", mime: "text/plain", url: "file:///tmp/incorrect.txt%00suffix" },
      { type: "file", mime: "text/plain", source: { type: "file", path: "/tmp/incorrect.txt\0suffix" } },
    ]);
    const log = (await readOpenCodeLog(source))!;
    expect(log.total).toBe(1); expect(log.messages).toHaveLength(1);
    expect(log.messages[0]?.blocks.every(block => block.kind === "text")).toBe(true);
    expect(JSON.stringify(log)).not.toContain("incorrect.txt");
  });
  test("pages equal-timestamp messages deterministically, sees updates/deletes and preserves ids", async () => {
    const { db, source } = await fixture();
    for (let i = 0; i < 6; i++) openCodeFixtureMessage(db, `msg_${i}`, "assistant", 100, [{ type: "text", text: String(i) }]);
    expect(texts(await readOpenCodeLog(source, { limit: 2 }))).toEqual(["4", "5"]);
    const older = await readOpenCodeLog(source, { limit: 2, before: 4 });
    expect(texts(older)).toEqual(["2", "3"]); expect(older?.offset).toBe(2);
    const before = await openCodeStamp(source);
    db.run("UPDATE part SET data=? WHERE id='prt_5_0'", [JSON.stringify({ type: "text", text: "UPDATED" })]);
    expect((await openCodeStamp(source)).version).not.toBe(before.version);
    expect(texts(await readOpenCodeLog(source, { limit: 1 }))).toEqual(["UPDATED"]);
    expect((await readOpenCodeLog(source, { limit: 1 }))?.messages[0]?.id).toBe(`${sid}:msg_5`);
    db.run("DELETE FROM message WHERE id='msg_5'");
    expect((await readOpenCodeLog(source))?.total).toBe(5);
    expect((await readOpenCodeLog(source, { before: 0 }))?.messages).toEqual([]);
  });
  test("hides an undone turn and every later message, restores on redo", async () => {
    const { db, source } = await fixture();
    for (let i = 0; i < 4; i++) openCodeFixtureMessage(db, `msg_${i}`, i % 2 ? "assistant" : "user", i, [{ type: "text", text: String(i) }]);
    const original = await readOpenCodeLog(source);
    db.run("UPDATE session SET revert=? WHERE id=?", [JSON.stringify({ messageID: "msg_2" }), sid]);
    const undone = await readOpenCodeLog(source);
    expect(texts(undone)).toEqual(["0", "1"]);
    expect(undone?.path).not.toBe(original?.path);
    db.run("UPDATE session SET revert=NULL WHERE id=?", [sid]);
    const redone = await readOpenCodeLog(source);
    expect(texts(redone)).toEqual(["0", "1", "2", "3"]);
    expect(redone?.path).toBe(original?.path);
  });
  test("a missed undo followed by new work permanently changes the view identity", async () => {
    const { db, source } = await fixture();
    for (let i = 0; i < 4; i++) openCodeFixtureMessage(db, `msg_${i}`, i % 2 ? "assistant" : "user", i, [{ type: "text", text: String(i) }]);
    const original = await readOpenCodeLog(source);
    // OpenCode's SessionRevert.cleanup removes the old branch, publishes its
    // durable removal events, then clears the temporary revert marker.
    db.run("DELETE FROM message WHERE id IN ('msg_2','msg_3')");
    db.run("INSERT INTO event VALUES ('evt_delete',?,50,'message.removed.1','{}')", [sid]);
    openCodeFixtureMessage(db, "msg_4", "user", 4, [{ type: "text", text: "New branch" }]);
    const branched = await readOpenCodeLog(source);
    expect(branched?.path).not.toBe(original?.path); expect(branched?.path).toContain(":revision:50");
    openCodeFixtureMessage(db, "msg_5", "assistant", 5, [{ type: "text", text: "Reply" }]);
    db.run("INSERT INTO event VALUES ('evt_append',?,60,'message.updated.1','{}')", [sid]);
    expect((await readOpenCodeLog(source))?.path).toBe(branched?.path);
    db.run("INSERT INTO event VALUES ('evt_foreign','ses_other',999,'message.removed.1','{}')");
    expect((await readOpenCodeLog(source))?.path).toBe(branched?.path);
    db.run("INSERT INTO event VALUES ('evt_part',?,61,'message.part.removed.1','{}')", [sid]);
    expect((await readOpenCodeLog(source))?.path).not.toBe(branched?.path);
  });
  test("a corrupt part does not hide adjacent messages; long content and pages stay bounded", async () => {
    const { db, source } = await fixture();
    openCodeFixtureMessage(db, "msg_0", "user", 1, [{ type: "text", text: "before" }]);
    openCodeFixtureMessage(db, "msg_1", "assistant", 2, [{ type: "text", text: "x".repeat(2_000_000) }, { type: "tool", tool: "bash", state: { status: "completed", input: {}, output: "y".repeat(2_000_000) } }]);
    db.run("INSERT INTO part VALUES ('prt_corrupt','msg_1',?,2,2,'{broken')", [sid]);
    const log = await readOpenCodeLog(source);
    expect(log?.messages).toHaveLength(2); expect(JSON.stringify(log).length).toBeLessThan(100_000);
    expect(JSON.stringify(log)).toContain("Reader excerpt");
  });
  test("serves inline images by session-scoped refs only and keeps base64 out of pages", async () => {
    const { db, source } = await fixture();
    const data = Buffer.from("image fixture").toString("base64");
    openCodeFixtureMessage(db, "msg_img", "user", 1, [{ id: "prt_image", type: "file", mime: "image/png", url: `data:image/png;base64,${data}` }]);
    openCodeFixtureMessage(db, "msg_tool", "assistant", 2, [{ id: "prt_tool", type: "tool", tool: "read", state: { status: "completed", input: {}, output: "image", attachments: [null, "malformed", { mime: "image/jpeg", url: `data:image/jpeg;base64,${data}` }] } }]);
    const log = await readOpenCodeLog(source);
    expect(JSON.stringify(log)).not.toContain(data);
    expect((await readOpenCodeImage(source, `${sid}:prt_image:file`))?.bytes).toEqual(Buffer.from("image fixture"));
    expect((await readOpenCodeImage(source, `${sid}:prt_tool:a2`))?.mediaType).toBe("image/jpeg");
    expect(log?.messages[1]?.blocks[0]).toMatchObject({ result: { images: [`${sid}:prt_tool:a2`] } });
    expect(await readOpenCodeImage(source, "ses_other:prt_image:file")).toBeNull();
    expect(await readOpenCodeImage(source, `${sid}:prt_image:a0`)).toBeNull();
    db.run("UPDATE part SET data=? WHERE id='prt_image'", [JSON.stringify({ type: "file", mime: "image/svg+xml", url: "data:image/svg+xml;base64,PHN2Zz4=" })]);
    expect(await readOpenCodeImage(source, `${sid}:prt_image:file`)).toBeNull();
  });
});
