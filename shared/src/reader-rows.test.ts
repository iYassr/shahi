import { expect, test } from "bun:test";
import type { LogBlock, LogMessage } from "./index";
import { readerRows, readerActivityLabel } from "./reader-rows";

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
