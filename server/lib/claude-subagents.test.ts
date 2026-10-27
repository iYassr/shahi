import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readerRows } from "@shahi/shared";
import { withSubagentCalls } from "./claude-subagents";
import { transcriptPage } from "./conversation-summary";
import { normalise } from "./session-log";

const root = mkdtempSync(join(tmpdir(), "shahi-claude-subagents-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SESSION = "f6ae57f1-716d-4822-99c1-d7394d2edc4a";
const transcript = join(root, `${SESSION}.jsonl`);
const subagents = join(root, SESSION, "subagents");
mkdirSync(subagents, { recursive: true });
// As Claude Code 2.1.311 wrote them for two background agents on 27 October 2026.
const meta = (taskId: string, toolUseId: unknown, description: string) =>
  writeFileSync(join(subagents, `agent-${taskId}.meta.json`), JSON.stringify({ agentType: "general-purpose", description, toolUseId, spawnDepth: 1, requestShape: "background", finished: true }));
meta("a82a6317c36451624", "toolu_017Q", "Sleeper two");
meta("aba68add0e8a0bb3e", "toolu_014N", "Sleeper one");
meta("a000000000000bad1", "../../etc", "Odd");

let n = 0;
const row = (type: string, content: unknown, over: Record<string, unknown> = {}) =>
  ({ type, uuid: `r${n++}`, timestamp: `2026-10-27T02:5${n % 10}:00.000Z`, message: { role: type, content }, ...over });
const notification = (lines: string[]) => row("user", ["<task-notification>", ...lines, "</task-notification>"].join("\n"), { origin: { kind: "task-notification" } });

// The whole of one measured run: two agents launched, each stopping to wait
// on its own `sleep 240` ("completed", interim), then handing its report back
// as a message, with a last notice that only points at that message. Screen
// drew both running until the hand-back, then neither.
const rows = [
  row("assistant", [
    { type: "tool_use", id: "toolu_014N", name: "Agent", input: { description: "Sleeper one", prompt: "sleep 240", subagent_type: "general-purpose", run_in_background: true } },
    { type: "tool_use", id: "toolu_017Q", name: "Agent", input: { description: "Sleeper two", prompt: "sleep 240", subagent_type: "general-purpose", run_in_background: true } },
  ]),
  row("user", [
    { type: "tool_result", tool_use_id: "toolu_014N", content: [{ type: "text", text: "Async agent launched successfully.\nagentId: aba68add0e8a0bb3e" }] },
    { type: "tool_result", tool_use_id: "toolu_017Q", content: [{ type: "text", text: "Async agent launched successfully.\nagentId: a82a6317c36451624" }] },
  ], { toolUseResult: { status: "async_launched" } }),
  ...["a82a6317c36451624:toolu_017Q:Sleeper two", "aba68add0e8a0bb3e:toolu_014N:Sleeper one"].map((entry) => {
    const [task, call, name] = entry.split(":");
    return notification([`<task-id>${task}</task-id>`, `<tool-use-id>${call}</tool-use-id>`, "<status>completed</status>",
      `<summary>Agent "${name}" is waiting on its own background work</summary>`,
      "<note>This agent stopped with background work of its own still running. It may resume on its own when that work completes or reports, and the same task-id notifies again if it does; the result below may be interim.</note>",
      "<result>This agent has not reported yet: it is waiting on its own background work and will deliver its report through SubagentHandback when that finishes.\n</result>"]);
  }),
];
const handback = (taskId: string, report: string) => row("user", `Another Claude session sent a message:\n<agent-message from="${taskId}">\n[Subagent hand-back] … The report follows:\n  ${report}\n</agent-message>`,
  { isMeta: true, origin: { kind: "peer", from: taskId, senderTaskId: taskId, name: "general-purpose", handback: true, handbackReportText: report, body: "[Subagent hand-back] …" } });
const finished = (taskId: string, name: string) => notification([`<task-id>${taskId}</task-id>`, "<status>completed</status>", `<summary>Agent "${name}" finished</summary>`,
  "<note>A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.</note>",
  `<result>This agent's report was delivered to you as a message from "${taskId}" (its SubagentHandback call). Read it there; it is not repeated here.\n</result>`]);

const states = async (all: Record<string, unknown>[]) => {
  const page = await withSubagentCalls({ path: transcript, messages: normalise(all) } as never, transcript);
  return readerRows(page.messages).flatMap(r => (r as any).blocks ?? []).filter((b: any) => b.subagent).map((b: any) => [b.subagent.description, b.subagent.state, b.subagent.report ?? null]);
};

test("a subagent waiting on its own background work is still running", async () => {
  expect(await states(rows)).toEqual([["Sleeper one", "running", null], ["Sleeper two", "running", null]]);
});

test("its hand-back ends it with its report, before or after its last notice", async () => {
  expect(await states([...rows, handback("a82a6317c36451624", "finished\n\n(Note: ran in the background.)"), finished("a82a6317c36451624", "Sleeper two"),
    finished("aba68add0e8a0bb3e", "Sleeper one"), handback("aba68add0e8a0bb3e", "finished")]))
    .toEqual([["Sleeper one", "done", "finished"], ["Sleeper two", "done", "finished\n\n(Note: ran in the background.)"]]);
});

test("the notice that only points at the hand-back says nothing of its own", () => {
  expect(normalise([finished("a82a6317c36451624", "Sleeper two")])).toEqual([]);
});

test("a task id without a recorded call stays a note, and the page never carries the task id", async () => {
  const messages = normalise([handback("a000000000000bad1", "odd"), handback("a0000000000000000", "nobody"), handback("../x", "escape")]);
  // An id that could leave the folder is never a task id at all.
  expect(messages).toHaveLength(2);
  const page = await withSubagentCalls({ path: transcript, messages } as never, transcript);
  for (const message of page.messages) expect((message.blocks[0] as any).notice).toEqual({ status: "completed" });
});

test("pages resolve task ids through the session's subagent records", async () => {
  writeFileSync(transcript, [...rows, handback("a82a6317c36451624", "finished")].map(r => JSON.stringify(r)).join("\n") + "\n");
  const page = await transcriptPage("subagents-test", transcript, "claude", { limit: 50 });
  const report = page!.log.messages.at(-1)!.blocks[0] as any;
  expect(report.notice).toEqual({ status: "completed", toolUseId: "toolu_017Q" });
  expect(JSON.stringify(page!.log)).not.toContain("taskId");
});
