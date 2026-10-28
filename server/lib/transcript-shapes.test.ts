/**
 * The decisions in transcript-shapes.ts, held to what the readers do. A
 * decision that says "dropped" while the reader shows the row, or "shown"
 * while it drops it, would make the census pass for the wrong reason.
 */
import { describe, expect, test } from "bun:test";
import { normaliseCodex } from "./codex-log";
import { normalise } from "./session-log";
import { CLAUDE_SHAPES, CODEX_SHAPES, claudeShapes, codexShapes, unclassified } from "./transcript-shapes";

const keys = (table: Record<string, { handling: string }>, prefix: string, handling: string) =>
  Object.entries(table).filter(([key, decision]) => key.startsWith(prefix) && decision.handling === handling).map(([key]) => key.slice(prefix.length));

describe("Claude Code", () => {
  test("a row yields its record, subtype, attachment, block, tool and result keys", () => {
    expect(claudeShapes({ type: "system", subtype: "turn_duration" })).toEqual(["record:system", "system:turn_duration"]);
    expect(claudeShapes({ type: "attachment", attachment: { type: "queued_command", commandMode: "prompt" } }))
      .toEqual(["record:attachment", "attachment:queued_command", "queued:prompt"]);
    expect(claudeShapes({ type: "assistant", message: { content: [{ type: "text" }, { type: "tool_use", name: "mcp__github__x" }, { type: "tool_use", name: "Bash" }] } }))
      .toEqual(["record:assistant", "block:assistant.text", "block:assistant.tool_use", "tool:mcp__*", "block:assistant.tool_use", "tool:Bash"]);
    expect(claudeShapes({ type: "user", message: { content: [{ type: "tool_result", content: [{ type: "image" }] }] } }))
      .toEqual(["record:user", "block:user.tool_result", "result:image"]);
    expect(claudeShapes(null)).toEqual([]);
  });

  // Claude Code 2.1.301 copies each message it sends into the transcript, with
  // the message's own role and blocks: drawn, every reply would show twice.
  test("a request log's message copies are one dropped record, never messages of their own", () => {
    const copy = { type: "api-request-blob", hash: "h", sessionId: "s", message: { role: "assistant", content: [{ type: "text", text: "Done." }, { type: "tool_use", id: "t", name: "Bash", input: {} }] } };
    expect(claudeShapes(copy)).toEqual(["record:api-request-blob"]);
    expect(normalise([copy, { ...copy, message: { role: "user", content: "Fix it." } }])).toEqual([]);
  });

  test("every record type said to be dropped produces nothing in Reader", () => {
    for (const type of keys(CLAUDE_SHAPES, "record:", "dropped")) {
      expect([type, normalise([{ type, uuid: "r", content: "text", message: { content: "text" } }])]).toEqual([type, []]);
    }
  });

  test("every informational level is shown or dropped as its decision says", () => {
    for (const level of Object.keys(CLAUDE_SHAPES).filter(key => key.startsWith("informational:")).map(key => key.slice(14))) {
      const shown = normalise([{ type: "system", subtype: "informational", level, uuid: "i", content: "Something happened." }]).length > 0;
      expect([level, shown]).toEqual([level, CLAUDE_SHAPES[`informational:${level}`]!.handling === "shown"]);
    }
    expect(claudeShapes({ type: "system", subtype: "informational", level: "warning" })).toEqual(["record:system", "system:informational", "informational:warning"]);
  });

  test("every system subtype is shown or dropped as its decision says", () => {
    // `informational` is decided by level, in the test above.
    for (const subtype of Object.keys(CLAUDE_SHAPES).filter(key => key.startsWith("system:") && key !== "system:informational").map(key => key.slice(7))) {
      const shown = normalise([{ type: "system", subtype, uuid: "s", content: "Something happened." }]).length > 0;
      expect([subtype, shown]).toEqual([subtype, CLAUDE_SHAPES[`system:${subtype}`]!.handling === "shown"]);
    }
  });

  test("every attachment said to be dropped produces nothing in Reader", () => {
    for (const type of keys(CLAUDE_SHAPES, "attachment:", "dropped")) {
      expect([type, normalise([{ type: "attachment", uuid: "a", attachment: { type, prompt: "text", content: "text" } }])]).toEqual([type, []]);
    }
  });

  test("every tool whose state stays on Screen carries that state", () => {
    const call = (name: string, input: Record<string, unknown>) =>
      normalise([{ type: "assistant", uuid: "c", message: { content: [{ type: "tool_use", id: "toolu_1", name, input }] } }])[0]!.blocks[0]!;
    expect(call("Agent", { description: "Survey", prompt: "p" })).toHaveProperty("subagent");
    expect(call("Task", { description: "Survey", prompt: "p" })).toHaveProperty("subagent");
    expect(call("TodoWrite", { todos: [{ content: "Read", status: "pending" }] })).toHaveProperty("todos");
    expect(call("AskUserQuestion", { questions: [{ question: "Which?", options: [{ label: "A" }] }] })).toHaveProperty("questions");
    // TaskCreate, TaskUpdate, TaskList and TaskGet are read from Claude Code's
    // task store rather than from the calls (claude-tasks.test.ts).
    expect(keys(CLAUDE_SHAPES, "tool:", "state").sort()).toEqual(["Agent", "AskUserQuestion", "Task", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "TodoWrite"]);
  });
});

describe("Codex", () => {
  test("reasoning configuration updates are classified as model controls, not conversation", () => {
    const row = { type: "response_item", payload: { type: "configuration_update", reasoning: { effort: "high" } } };
    expect(codexShapes(row)).toEqual(["record:response_item", "response:configuration_update"]);
    expect(unclassified(new Map(codexShapes(row).map(key => [key, 1])), CODEX_SHAPES)).toEqual([]);
    expect(CODEX_SHAPES["response:configuration_update"]?.handling).toBe("dropped");
    expect(normaliseCodex([row])).toEqual([]);
  });

  test("a row yields its record, event, item and response keys", () => {
    expect(codexShapes({ type: "event_msg", payload: { type: "item_completed", item: { type: "Reasoning" } } }))
      .toEqual(["record:event_msg", "event:item_completed", "item:Reasoning"]);
    expect(codexShapes({ type: "response_item", payload: { type: "function_call" } })).toEqual(["record:response_item", "response:function_call"]);
  });

  test("every item said to be dropped produces nothing in Reader", () => {
    for (const type of keys(CODEX_SHAPES, "item:", "dropped")) {
      const row = { type: "event_msg", timestamp: "2026-10-01T12:00:00Z", payload: { type: "item_completed", item: { type, id: "i", text: "text", kind: "started" } } };
      expect([type, normaliseCodex([row])]).toEqual([type, []]);
    }
  });

  test("every record type said to be dropped produces nothing in Reader", () => {
    for (const type of keys(CODEX_SHAPES, "record:", "dropped")) {
      expect([type, normaliseCodex([{ type, payload: { type: "message", message: "text" } }])]).toEqual([type, []]);
    }
  });
});

test("unclassified keys are listed most frequent first", () => {
  const counts = new Map([["record:user", 9], ["record:new-thing", 2], ["tool:NewTool", 5]]);
  expect(unclassified(counts, CLAUDE_SHAPES)).toEqual([["tool:NewTool", 5], ["record:new-thing", 2]]);
});
