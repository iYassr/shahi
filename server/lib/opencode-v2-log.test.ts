import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { findOpenCodeTranscript, type OpenCodeTranscript } from "./opencode-log";
import { readOpenCodeV2Log } from "./opencode-v2-log";
import { createOpenCodeFixture, createOpenCodeV2Fixture, openCodeFixtureMessage, openCodeV2Message, OPEN_CODE_SESSION as sid } from "./opencode-log-fixtures";

const roots: string[] = [], handles: Database[] = [];
afterEach(async () => { for (const db of handles.splice(0)) db.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "shahi-opencode-v2-")); roots.push(root);
  const path = join(root, "opencode.db"), db = createOpenCodeV2Fixture(path); handles.push(db);
  return { db, path, source: { kind: "opencode", databasePath: path, sessionId: sid, schema: 2 } as OpenCodeTranscript };
}
const texts = (log: Awaited<ReturnType<typeof readOpenCodeV2Log>>) => log?.messages.map(m => `${m.role}: ${m.blocks.map(b => "text" in b ? b.text : b.kind).join(" | ")}`);

// The three rows OpenCode 2.2.0 wrote for the agent journey's first message on
// 28 October 2026, as the Linux computer's database held them.
function journey(db: Database) {
  openCodeV2Message(db, "msg_17fd57baa001ha1GzIv1N80uRz", "user", 4, { text: "Reply with exactly the word shahi-opencode-hand-s8pod0 and nothing else.", files: [], agents: [] });
  openCodeV2Message(db, "msg_17fd57c4e001AsAUaCegEVVXXQ", "assistant", 5, { agent: "build", model: { id: "deepseek-flash", providerID: "deepseek", variant: "high" },
    content: [{ type: "text", text: "shahi-opencode-hand-s8pod0" }], snapshot: { start: "4b825dc6", end: "4b825dc6", files: [] }, finish: "stop", rawFinish: "stop",
    cost: 0.0005684, tokens: { input: 3665, output: 10, reasoning: 0, cache: { read: 4224, write: 0 } } });
  openCodeV2Message(db, "msg_17fd57f9a001qx30ZA0yO1dP2x", "idle", 10, { outcome: "succeeded" });
}

describe("finding an OpenCode 2 conversation", () => {
  test("a session only OpenCode 2 has written is read from its tables", async () => {
    const { path } = await fixture();
    expect(await findOpenCodeTranscript(sid, path)).toEqual({ kind: "opencode", databasePath: path, sessionId: sid, schema: 2 });
    expect(await findOpenCodeTranscript("ses_unknown", path)).toBeNull();
  });
  test("a session in both projections is read from the one written last", async () => {
    const root = await mkdtemp(join(tmpdir(), "shahi-opencode-v2-")); roots.push(root);
    const path = join(root, "opencode.db"), v1 = createOpenCodeFixture(path); handles.push(v1);
    expect(await findOpenCodeTranscript(sid, path)).toEqual({ kind: "opencode", databasePath: path, sessionId: sid });
    v1.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY,version TEXT,revert TEXT);
      CREATE TABLE session_message (id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER,time_updated INTEGER,data TEXT);`);
    v1.run("INSERT INTO session_v2 (id,version) VALUES (?,?)", [sid, "1.17.11"]);
    openCodeFixtureMessage(v1, "msg_old", "user", 1_000, [{ type: "text", text: "on 1.x" }]);
    openCodeV2Message(v1, "msg_copied", "user", 1, { text: "copied by 2.x" });
    expect((await findOpenCodeTranscript(sid, path))?.schema).toBe(2);
    openCodeFixtureMessage(v1, "msg_after", "user", 1_793_200_000_000, [{ type: "text", text: "1.x again" }]);
    expect((await findOpenCodeTranscript(sid, path))?.schema).toBeUndefined();
  });
});

describe("OpenCode 2 messages", () => {
  test("the measured journey reads as the person's message and the reply", async () => {
    const { db, source } = await fixture(); journey(db);
    const log = await readOpenCodeV2Log(source);
    expect(texts(log)).toEqual(["you: Reply with exactly the word shahi-opencode-hand-s8pod0 and nothing else.", "agent: shahi-opencode-hand-s8pod0"]);
    expect(log?.messages[0]?.id).toBe(`${sid}:msg_17fd57baa001ha1GzIv1N80uRz`);
    expect(log?.messages[1]?.at).toBe(1_793_146_059_005);
    expect(log?.total).toBe(2);
    expect(log?.sessionId).toBe(sid);
  });

  test("reasoning, tools in every state, questions and a failed step", async () => {
    const { db, source } = await fixture();
    openCodeV2Message(db, "msg_a", "assistant", 1, { agent: "build", model: { id: "m", providerID: "p" }, error: { type: "provider", message: "Rate limited" }, content: [
      { type: "reasoning", text: "Look first" },
      { type: "tool", id: "t1", name: "shell", state: { status: "completed", input: { command: "ls -la" }, content: [{ type: "text", text: "a\nb" }], metadata: { exit: 0 } }, time: { created: 1 } },
      { type: "tool", id: "t2", name: "edit", state: { status: "error", input: { path: "/tmp/x.ts", oldString: "a", newString: "b" }, error: { type: "tool", message: "No match" } }, time: { created: 1 } },
      { type: "tool", id: "t3", name: "read", state: { status: "running", input: { path: "/tmp/y.ts" }, metadata: {} }, time: { created: 1 } },
      { type: "tool", id: "t4", name: "question", state: { status: "completed", input: { questions: [{ question: "Which?", options: [{ label: "One", description: "first" }] }] }, content: [{ type: "text", text: "One" }] }, time: { created: 1 } },
      { type: "tool", id: "t5", name: "write", state: { status: "completed", input: { path: "/tmp/z.md", content: "# Notes" }, content: [{ type: "text", text: "Wrote" }, { type: "file", uri: "media:00", mime: "image/png", name: "shot.png" }] }, time: { created: 1 } },
      { type: "tool", id: "t6", name: "shell", state: { status: "pending", input: { command: "never" } }, time: { created: 1 } },
      { type: "unknown", text: "never" },
      { type: "text", text: "Done" },
    ] });
    const blocks = (await readOpenCodeV2Log(source))!.messages[0]!.blocks as any[];
    expect(blocks.map(b => b.kind)).toEqual(["thinking", "tool", "tool", "tool", "tool", "tool", "text", "text"]);
    expect(blocks[1]).toMatchObject({ name: "shell", summary: "ls -la", result: { text: "a\nb", isError: false } });
    expect(blocks[2]).toMatchObject({ name: "edit", file: { path: "/tmp/x.ts", name: "x.ts" }, result: { text: "No match", isError: true } });
    expect(blocks[3]).toMatchObject({ name: "read", result: null });
    expect(blocks[4].questions).toEqual([{ text: "Which?", options: [{ label: "One", description: "first" }] }]);
    expect(blocks[5].result.text).toBe("Wrote\n\n# Notes\n\nFile: shot.png");
    expect(blocks.at(-1)).toEqual({ kind: "text", text: "Rate limited" });
    expect(JSON.stringify(blocks)).not.toContain("never");
  });

  test("notices are drawn as the TUI draws them, and its chrome is not", async () => {
    const { db, source } = await fixture();
    const rows: [string, Record<string, unknown>][] = [
      ["synthetic", { text: "model-facing", description: "Fix the tests", metadata: { source: "subagent", agent: "explore", state: "completed", childID: "ses_child" } }],
      ["synthetic", { text: "model-facing", description: "npm   test\n  done", metadata: { source: "shell", state: "error" } }],
      ["synthetic", { text: "model-facing only", metadata: { instruction: true } }],
      ["system", { text: "model-facing", description: "Plan mode is on" }],
      ["system", { text: "model-facing only" }],
      ["skill", { skill: "sk_1", name: "review", text: "model-facing" }],
      ["shell", { shellID: "sh_1", command: "git status", status: "completed", exit: 1, output: { output: "fatal: not a repository" } }],
      ["compaction", { status: "completed", reason: "auto", summary: "…" }],
      ["compaction", { status: "running", reason: "manual", summary: "" }],
      ["compaction", { status: "failed", reason: "manual", error: { type: "aborted", message: "Cancelled" } }],
      ["agent-switched", { agent: "plan", previous: "build" }],
      ["model-switched", { model: { id: "gpt-6.1-terra", providerID: "openai" } }],
      ["location-switched", { location: { directory: "/srv/app" } }],
      ["idle", { outcome: "failed", error: { type: "provider", message: "Out of credit" } }],
      ["idle", { outcome: "succeeded" }],
      ["mystery", { text: "never" }],
    ];
    rows.forEach(([type, data], i) => openCodeV2Message(db, `msg_${i}`, type, i + 1, data));
    db.run("INSERT INTO session_message VALUES ('msg_bad',?,'user',99,1,1,'{not json')", [sid]);
    const log = await readOpenCodeV2Log(source);
    expect(texts(log)).toEqual([
      "system: Explore finished · Fix the tests",
      "system: Shell failed · npm test done",
      "system: Plan mode is on",
      "system: Skill review",
      "you: ! git status | fatal: not a repository | Command exited with code 1",
      "system: Conversation compacted automatically.",
      "system: Switched agent from Build to Plan",
      "system: Switched model to gpt-6.1-terra",
      "system: Moved to /srv/app",
      "system: Out of credit",
    ]);
    expect(log?.total).toBe(10);
    expect(JSON.stringify(log)).not.toContain("model-facing");
  });

  test("a person's attachments are named and a local file opens", async () => {
    const { db, source } = await fixture();
    openCodeV2Message(db, "msg_u", "user", 1, { text: "", agents: [{ name: "explore" }], files: [
      { data: "iVBORw0KGgo=", mime: "image/png", source: { type: "inline" }, name: "shot.png" },
      { mime: "text/plain", source: { type: "uri", uri: "file:///tmp/notes.txt" }, name: "notes.txt", data: "eA==" },
      { uri: "media:" + "a".repeat(64), mime: "application/pdf", source: { type: "inline" } },
    ] });
    const blocks = (await readOpenCodeV2Log(source))!.messages[0]!.blocks as any[];
    expect(blocks).toMatchObject([{ kind: "text", text: "Attachment: shot.png (image/png)" }, { kind: "tool", name: "Attachment", file: { path: "/tmp/notes.txt" } },
      { kind: "text", text: "Attachment: application/pdf" }, { kind: "text", text: "@explore" }]);
    expect(JSON.stringify(blocks)).not.toContain("iVBORw0KGgo");
  });

  test("selected skills stay visible, including a user turn with no prose", async () => {
    const { db, source } = await fixture();
    // v2.2.0's Prompt.SkillAttachment and TUI UserMessage show the skill's
    // name. Its model-facing instructions are not the person's message.
    openCodeV2Message(db, "msg_skill_only", "user", 1, { text: "", skills: [{ id: "sk_review", name: "review", text: "model-facing instructions" }] });
    openCodeV2Message(db, "msg_with_skill", "user", 2, { text: "Check this", skills: [{ id: "sk_tests", name: "tests" }] });
    openCodeV2Message(db, "msg_unknown_skills", "user", 3, { text: "", skills: [null, {}, { name: 7 }, { name: { text: "not a skill name" } }, { name: "" }] });
    const tail = await readOpenCodeV2Log(source, { limit: 1 });
    expect(texts(tail)).toEqual(["you: Check this | Skill: tests"]);
    expect([tail?.total, tail?.offset]).toEqual([2, 1]);
    const earlier = await readOpenCodeV2Log(source, { limit: 1, before: 1 });
    expect(texts(earlier)).toEqual(["you: Skill: review"]);
    expect(earlier?.offset).toBe(0);
    expect(JSON.stringify(earlier)).not.toContain("model-facing instructions");
  });

  test("long text and tool output are cut with a note, inside SQLite", async () => {
    const { db, source } = await fixture();
    openCodeV2Message(db, "msg_u", "user", 1, { text: "x".repeat(70_000) });
    openCodeV2Message(db, "msg_a", "assistant", 2, { agent: "build", model: { id: "m", providerID: "p" }, content: [
      { type: "tool", id: "t", name: "shell", state: { status: "completed", input: { command: "cat big" }, content: [{ type: "text", text: "y".repeat(20_000) }] }, time: { created: 1 } },
    ] });
    const [user, agent] = (await readOpenCodeV2Log(source))!.messages as any[];
    expect(user.blocks[0].text.length).toBeLessThan(65_600);
    expect(user.blocks[0].text).toEndWith("… [Reader excerpt]");
    expect(agent.blocks[0].result.truncated).toBe(true);
    expect(agent.blocks[0].result.text.length).toBeLessThan(8_300);
  });
});

describe("OpenCode 2 pages and undo", () => {
  test("pages count only drawn messages and walk back by them", async () => {
    const { db, source } = await fixture();
    for (let i = 0; i < 5; i++) {
      openCodeV2Message(db, `msg_u${i}`, "user", i * 3 + 1, { text: `question ${i}` });
      openCodeV2Message(db, `msg_i${i}`, "idle", i * 3 + 2, { outcome: "succeeded" });
    }
    const tail = await readOpenCodeV2Log(source, { limit: 2 });
    expect(texts(tail)).toEqual(["you: question 3", "you: question 4"]);
    expect([tail?.total, tail?.offset]).toEqual([5, 3]);
    expect(texts(await readOpenCodeV2Log(source, { limit: 2, before: 3 }))).toEqual(["you: question 1", "you: question 2"]);
  });

  test("an undone turn is hidden until committed, and its removal changes the path", async () => {
    const { db, source } = await fixture(); journey(db);
    const before = await readOpenCodeV2Log(source);
    db.run("UPDATE session_v2 SET revert = ? WHERE id = ?", [JSON.stringify({ messageID: "msg_17fd57baa001ha1GzIv1N80uRz" }), sid]);
    const staged = await readOpenCodeV2Log(source);
    expect(staged?.messages).toEqual([]);
    expect(staged?.path).not.toBe(before?.path);
    // The next prompt commits the undo: the undone rows go and a new turn follows.
    db.run("DELETE FROM session_message WHERE session_id = ? AND seq >= 4", [sid]);
    db.run("UPDATE session_v2 SET revert = NULL WHERE id = ?", [sid]);
    openCodeV2Message(db, "msg_new", "user", 12, { text: "Something else" });
    const after = await readOpenCodeV2Log(source);
    expect(texts(after)).toEqual(["you: Something else"]);
    expect(after?.path).not.toBe(before?.path);
    expect(after?.path).not.toBe(staged?.path);
    // Appending afterwards keeps the new path: only a removal changes it.
    openCodeV2Message(db, "msg_more", "user", 14, { text: "And more" });
    expect((await readOpenCodeV2Log(source))?.path).toBe(after!.path);
  });

  test("anything but the reported session, or a damaged database, reads as nothing", async () => {
    const { db, source } = await fixture(); journey(db);
    expect(await readOpenCodeV2Log({ ...source, sessionId: "ses_other" })).toBeNull();
    expect(await readOpenCodeV2Log({ ...source, sessionId: "../x" })).toBeNull();
    db.exec("DROP TABLE session_message");
    expect(await readOpenCodeV2Log(source)).toBeNull();
  });
});
