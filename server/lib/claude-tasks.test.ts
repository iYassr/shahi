import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeTasks } from "./claude-tasks";
import { transcriptPage } from "./conversation-summary";

const root = mkdtempSync(join(tmpdir(), "shahi-claude-tasks-"));
const previous = process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CONFIG_DIR = root;
afterAll(() => {
  if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

const SESSION = "11111111-1111-4111-8111-111111111111";
const store = join(root, "tasks", SESSION);
mkdirSync(store, { recursive: true });
// The shape Claude Code 2.1 writes, one file per task; a deleted task's file is gone.
const task = (id: string, status: string, subject = `Task ${id}`) =>
  writeFileSync(join(store, `${id}.json`), JSON.stringify({ id, subject, description: "d", activeForm: `Doing ${id}`, status, blocks: [], blockedBy: [] }));
task("2", "completed");
task("10", "pending");
task("3", "in_progress");
task("4", "deleted");
writeFileSync(join(store, "5.json"), "{not json");
writeFileSync(join(store, ".highwatermark"), "10");
writeFileSync(join(store, ".lock"), "");

test("the session's tasks, in number order, without anything it cannot read", async () => {
  expect(await claudeTasks(SESSION)).toEqual([
    { id: "2", subject: "Task 2", status: "completed", activeForm: "Doing 2" },
    { id: "3", subject: "Task 3", status: "in_progress", activeForm: "Doing 3" },
    { id: "10", subject: "Task 10", status: "pending", activeForm: "Doing 10" },
  ]);
});

test("a session with no store has no list, and a name that is not a session is not looked up", async () => {
  expect(await claudeTasks("22222222-2222-4222-8222-222222222222")).toBeUndefined();
  expect(await claudeTasks("../tasks")).toBeUndefined();
});

test("the reader's tail page carries the list; an earlier page does not", async () => {
  const dir = join(root, "projects", "-tmp-x");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${SESSION}.jsonl`);
  const row = (n: number) => JSON.stringify({ type: "assistant", uuid: `a${n}`, timestamp: "2026-10-01T10:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text: `reply ${n}` }] } });
  writeFileSync(path, `${row(1)}\n${row(2)}\n`);
  const tail = await transcriptPage("tasks-pane", path, "claude", { limit: 60 });
  expect(tail!.log.tasks?.map(t => t.id)).toEqual(["2", "3", "10"]);
  const earlier = await transcriptPage("tasks-pane", path, "claude", { limit: 1, before: 1 });
  expect(earlier!.log.tasks).toBeUndefined();
});
