import { describe, expect, test } from "bun:test";
import type { LogBlock, LogMessage } from "./index";
import { readerRows, readerActivityLabel, readerTasks, readerTasksLabel } from "./reader-rows";

const text = (text: string): LogBlock => ({ kind: "text", text });
const tool = (name = "Bash", result: Extract<LogBlock, { kind: "tool" }>["result"] = null): LogBlock => ({ kind: "tool", name, summary: "cd /private && inspect", result });
const message = (id: string, blocks: LogBlock[], role: LogMessage["role"] = "agent"): LogMessage => ({ id, blocks, role, at: 1 });

test("many tool-only records become one disclosure below the response, without Agent timestamps for each step", () => {
  const input = [message("you", [text("Fix it")], "you"), message("intro", [text("I will check it.")]),
    ...Array.from({ length: 30 }, (_, i) => message(`tool-${i}`, [tool()])), message("answer", [text("Fixed and tested.")])];
  const rows = readerRows(input);
  expect(rows.map(row => row.id)).toEqual(["you", "intro", "answer", 'activity:["tool-0",0]']);
  expect(rows.filter(row => row.role === "agent" && row.showHeader)).toHaveLength(1);
  expect(rows.at(-1)!.activity!.steps).toHaveLength(30);
  expect(rows[2]!.blocks).toEqual([text("Fixed and tested.")]);
  expect(input).toHaveLength(33);
});

test("questions, failures and images stay visible; file links and tool images survive collapsed activity", () => {
  const result = { text: "done", isError: false, truncated: false, images: ["screenshot"] };
  const file = { path: "/home/test/report.pdf", name: "report.pdf" };
  const fileTool: LogBlock = { ...tool("Read", result) as Extract<LogBlock, { kind: "tool" }>, file };
  const question: LogBlock = { ...tool("AskUserQuestion") as Extract<LogBlock, { kind: "tool" }>, questions: [{ text: "Publish?", options: [{ label: "Review" }] }] };
  const failed = tool("Bash", { ...result, isError: true });
  const image: LogBlock = { kind: "image", mediaType: "image/png", ref: "answer-image" };
  const rows = readerRows([message("a", [fileTool, fileTool, question, failed, image, text("Answer")])]);
  expect(rows[0]!.blocks).toEqual([question, failed, image, text("Answer")]);
  expect(rows[1]!.activity!.files).toEqual([file]);
  expect(rows[1]!.activity!.images).toEqual(["screenshot"]);
});

test("user and system messages end a group; no thought or unknown tool is thrown away", () => {
  const input = [message("a", [{ kind: "thinking", text: "Reasoning" }, tool("mcp_call")]),
    message("system", [text("Interrupted")], "system"), message("b", [tool()]),
    message("user", [text("Another task")], "you"), message("c", [tool()])];
  const rows = readerRows(input);
  expect(rows.map(row => row.role)).toEqual(["agent", "system", "agent", "you", "agent"]);
  expect(rows[0]!.activity!.steps.map<LogBlock>(step => step.block)).toEqual(input[0]!.blocks);
  expect(rows[0]!.showHeader).toBe(false);
});

test("quiet polls retain row identity and an appended answer keeps the existing activity disclosure", () => {
  const input = [message("tool", [tool()])];
  const before = readerRows(input);
  expect(readerRows(input, before)).toBe(before);
  const answer = message("answer", [text("Done")]);
  const after = readerRows([...input, answer], before);
  expect(after[1]).toBe(before[0]);
  expect(after[0]!.id).toBe("answer");
  const updated = readerRows([{ ...input[0]!, blocks: [tool("Bash", { text: "new output", isError: false, truncated: false, images: [] })] }, answer], after);
  expect(updated[0]).toBe(after[0]);
  expect(updated[1]).not.toBe(after[1]);
});

test("prepending history preserves existing prose anchors and the disclosure key", () => {
  const page = [message("tool", [tool()]), message("answer", [text("Read this paragraph")])];
  const before = readerRows(page);
  const after = readerRows([message("earlier", [text("Earlier paragraph"), tool()]), ...page], before);
  expect(after.find(row => row.id === "answer")!.blocks).toEqual(before[0]!.blocks);
  expect(after.at(-1)!.id).toBe(before.at(-1)!.id);
  expect(after.at(-1)!.activity!.steps).toHaveLength(2);
});

test("live labels describe known operations without publishing command paths or inventing progress", () => {
  const activity = readerRows([message("x", [tool("Read")])])[0]!.activity!;
  expect(readerActivityLabel(activity, true)).toBe("Reading files… · 1 step");
  expect(readerActivityLabel(activity, false)).toBe("Activity · 1 step");
  const unknown = readerRows([message("x", [tool("mcp_call")])])[0]!.activity!;
  expect(readerActivityLabel(unknown, true)).toBe("Working… · 1 step");
});

describe("subagents and the task list", () => {
  const agentCall = (id: string, background: boolean, result: { text: string; isError?: boolean } | null = null) => ({
    kind: "tool" as const, name: "Agent", summary: "Research the census",
    subagent: { id, description: "Research the census", type: "general-purpose", background },
    result: result && { text: result.text, isError: !!result.isError, truncated: false, images: [] },
  });
  const notice = (toolUseId: string, status: string, report: string) => ({
    kind: "text" as const, text: `Agent "Research the census" finished (${status})\n${report}`, notice: { toolUseId, status },
  });
  const message = (id: string, role: "you" | "agent" | "system", blocks: unknown[]) => ({ id, role, at: 1, blocks }) as never;

  // Device report, October 2026: subagents were folded into the collapsed
  // activity as one more tool call, and their reports arrived as notes that
  // read as if the person had typed them.
  test("a background subagent is its own row, running until its report arrives, which it then holds", () => {
    const call = message("a1", "agent", [{ kind: "thinking", text: "plan" }, agentCall("toolu_1", true, { text: "Started in the background." })]);
    let rows = readerRows([call]);
    const view = rows[0]!.blocks[0] as any;
    expect(view.subagent).toMatchObject({ description: "Research the census", state: "running" });
    expect(view.subagent.report).toBeUndefined();
    expect(rows[1]!.activity?.steps).toHaveLength(1);

    const report = message("s1", "system", [notice("toolu_1", "completed", "Found eight answers.")]);
    rows = readerRows([call, report], rows);
    expect((rows[0]!.blocks[0] as any).subagent).toMatchObject({ state: "done", report: "Found eight answers." });
    // Folded into the subagent's row, not said again as a note.
    expect(rows.some(row => row.id === "s1")).toBe(false);
  });

  test("a report on something not loaded, or on a background command, stays a note", () => {
    const report = message("s1", "system", [notice("toolu_9", "failed", "Exited 1.")]);
    expect(readerRows([report]).map(row => row.id)).toEqual(["s1"]);
  });

  test("a failed or stopped background subagent says so", () => {
    const call = message("a1", "agent", [agentCall("toolu_1", true)]);
    expect(((readerRows([call, message("s1", "system", [notice("toolu_1", "failed", "Error.")])])[0]!.blocks[0]) as any).subagent.state).toBe("failed");
    expect(((readerRows([call, message("s1", "system", [notice("toolu_1", "killed", "")])])[0]!.blocks[0]) as any).subagent.state).toBe("stopped");
  });

  test("a subagent that answered in its own call is done with that answer", () => {
    const rows = readerRows([message("a1", "agent", [agentCall("toolu_1", false, { text: "The answer." })])]);
    expect((rows[0]!.blocks[0] as any).subagent).toMatchObject({ state: "done", report: "The answer." });
  });

  test("an unchanged subagent row is the same row on the next poll", () => {
    const messages = [message("a1", "agent", [agentCall("toolu_1", true)]), message("s1", "system", [notice("toolu_1", "completed", "Done.")])];
    const first = readerRows(messages);
    expect(readerRows(messages, first)).toBe(first);
  });

  test("the task list is the server's copy when it sent one, whatever page is loaded", () => {
    const tasks = [
      { id: "12", subject: "Fix the reader", status: "completed" as const },
      { id: "13", subject: "Ship build 30", status: "in_progress" as const, activeForm: "Shipping build 30" },
      { id: "14", subject: "Promote to Stable", status: "pending" as const },
    ];
    const list = readerTasks({ tasks }, [])!;
    expect(list).toMatchObject({ done: 1, inProgress: 1, open: 1 });
    expect(readerTasksLabel(list)).toBe("3 tasks (1 done, 1 in progress, 1 open)");
    expect(readerTasks({ tasks: [] }, [])).toBeNull();
  });

  test("without one, the latest TodoWrite among the loaded messages is the list", () => {
    const todo = (todos: { content: string; status: string }[]) => message(`t${todos.length}`, "agent", [{ kind: "tool", name: "TodoWrite", summary: "", todos, result: null }]);
    const list = readerTasks(undefined, [
      todo([{ content: "Old", status: "pending" }]),
      todo([{ content: "Read", status: "completed" }, { content: "Write", status: "in_progress" }]),
    ])!;
    expect(list.tasks.map(task => [task.subject, task.status])).toEqual([["Read", "completed"], ["Write", "in_progress"]]);
    expect(readerTasks(undefined, [])).toBeNull();
  });
});
