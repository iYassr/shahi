import { expect, test } from "bun:test";
import { normaliseCodex } from "./codex-log";

const item = (fields: object) => ({ type: "event_msg", timestamp: "2026-09-27T00:00:00Z", payload: { type: "item_completed", item: fields } });
const blocks = (fields: object) => normaliseCodex([item(fields)])[0]!.blocks;

test("Codex questions remain visible even when the message has no prose", () => {
  expect(blocks({ type: "AgentMessage", id: "a", content: [], questions: [{ title: "Which database?", options: ["SQLite", "Postgres"] }, { title: "Project name?", options: null }] }))
    .toEqual([{ kind: "tool", name: "Question", summary: "Which database?", result: null, questions: [
      { text: "Which database?", options: [{ label: "SQLite" }, { label: "Postgres" }] }, { text: "Project name?", options: [] },
    ] }]);
});

test("completed command items retain command, result and explicit failure", () => {
  const [block] = blocks({ type: "CommandExecution", command: ["/bin/zsh", "-lc", "cat missing.txt"], aggregated_output: "File not found", exit_code: 1, status: "failed" });
  expect(block).toMatchObject({ kind: "tool", name: "command", summary: "cat missing.txt", result: { text: "File not found", isError: true } });
  expect(blocks({ type: "CommandExecution", command: ["true"], status: "completed", exit_code: 0, stdout: "", stderr: "" })[0])
    .toMatchObject({ result: { text: "Exit code: 0", isError: false } });
});

test("web-search and image-generation extensions are displayed without shipping inline image bytes", () => {
  expect(blocks({ type: "Extension", kind: "web.search", query: "", action: { type: "findInPage", url: "https://example.com", pattern: "support" }, results: [] })[0])
    .toMatchObject({ name: "web_search", summary: "https://example.com · support", outputUnavailable: true });
  const [image] = blocks({ type: "Extension", kind: "image_gen.generation", status: "completed", revisedPrompt: "Blue square", result: "SECRET_BASE64_IMAGE", savedPath: "/tmp/square.png" });
  expect(image).toMatchObject({ name: "image_generation", summary: "Blue square", file: { path: "/tmp/square.png", name: "square.png" }, result: { text: "completed" } });
  expect(JSON.stringify(image)).not.toContain("SECRET_BASE64_IMAGE");
  expect(blocks({ type: "Extension", kind: "clock.sleep", durationMs: 1500 })[0]).toMatchObject({ name: "sleep", summary: "Waited 1.5 seconds" });
});

test("viewed images use the authenticated file viewer and refuse non-file or remote file URIs", () => {
  expect(blocks({ type: "ImageView", path: "file:///tmp/screenshot%20one.png" })[0])
    .toMatchObject({ name: "view_image", file: { path: "/tmp/screenshot one.png", name: "screenshot one.png" } });
  for (const path of ["https://example.com/a.png", "file://other-computer/a.png", "relative.png"]) {
    expect(blocks({ type: "ImageView", path })[0]).not.toHaveProperty("file");
  }
});

test("image-only and audio-only user messages do not disappear or leak inline data", () => {
  const messages = normaliseCodex([item({ type: "UserMessage", content: [
    { type: "image", image_url: "data:image/png;base64,SECRET" },
    { type: "local_image", path: "/tmp/input.png" },
    { type: "audio", audio_url: "data:audio/mp3;base64,SECRET" },
    { type: "skill", name: "review", path: "/tmp/SKILL.md" },
  ] })]);
  expect(messages[0]!.role).toBe("you");
  expect(messages[0]!.blocks).toHaveLength(4);
  expect(messages[0]!.blocks).toContainEqual(expect.objectContaining({ file: { path: "/tmp/input.png", name: "input.png" } }));
  expect(messages[0]!.blocks).toContainEqual({ kind: "image", mediaType: "image/png", ref: "0:0" });
  expect(JSON.stringify(messages)).not.toContain("SECRET");
});

test("plans, tool responses, failures, reviews and compaction keep their public content", () => {
  expect(blocks({ type: "Plan", text: "1. Read\n2. Test" })).toEqual([{ kind: "text", text: "1. Read\n2. Test" }]);
  expect(blocks({ type: "FunctionCallOutput", name: "request_user_input", output: [{ type: "input_text", text: "SQLite" }] })[0]).toMatchObject({ result: { text: "SQLite" } });
  expect(blocks({ type: "DynamicToolCall", tool: "lookup", status: "failed", error: "Unavailable" })[0]).toMatchObject({ result: { text: "Unavailable", isError: true } });
  expect(blocks({ type: "McpToolCall", tool: "read", server: "docs", status: "failed", result: null, error: { message: "Not connected" } })[0]).toMatchObject({ result: { text: "Not connected", isError: true } });
  expect(blocks({ type: "ExitedReviewMode", review_output: { findings: [{ title: "Wrong order", body: "New sessions sort last" }], overall_explanation: "Fix recency" } })).toEqual([{ kind: "text", text: "Wrong order\nNew sessions sort last\n\nFix recency" }]);
  expect(normaliseCodex([item({ type: "ContextCompaction" })])[0]).toMatchObject({ role: "system" });
});

test("new display records are defensive and cap large tool output without splitting emoji", () => {
  for (const type of ["CommandExecution", "DynamicToolCall", "FunctionCallOutput", "Extension", "ExitedReviewMode", "AgentMessage", "UserMessage"]) {
    expect(() => normaliseCodex([item({ type, command: [null, 1], content: [null, 3], content_items: [null], questions: [null, { title: 3 }], output: [null] })])).not.toThrow();
  }
  expect(blocks({ type: "CommandExecution", aggregated_output: "a".repeat(1999) + "😀rest", status: "completed" })[0])
    .toMatchObject({ result: { text: "a".repeat(1999), truncated: true } });
});
