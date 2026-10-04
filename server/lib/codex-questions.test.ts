import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readerRows } from "@shahi/shared";
import { normaliseCodex, readCodexWindow } from "./codex-log";
import { parsePrompt } from "./prompt-parser";
import { answerPrompt, keysFor } from "./answer";
import { submitPrompt } from "./prompt";
import { codexNotesTyped, codexQuestionPrompt } from "./provider-prompts";

// The sync question is a raw function call in Codex 0.160.0, while async
// questions are completed AgentMessages (codex-rs/core's two input handlers).
const questions = [
  { id: "database", header: "Database", question: "Which database?", options: [
    { label: "SQLite (Recommended)", description: "Use a local database." },
    { label: "Postgres", description: "Use a hosted database." },
  ] },
  { id: "name", header: "Name", question: "What project name?" },
];
const expected = [
  { text: "Which database?", options: questions[0]!.options },
  { text: "What project name?", options: [] },
];
const call = (name = "request_user_input", args: unknown = { questions }) => ({
  type: "response_item", payload: { type: "function_call", name, call_id: "input-call", arguments: JSON.stringify(args) },
});
const asyncItem = (text: string, delivery = "async") => ({
  type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", id: "async-call", delivery,
    content: [{ type: "Text", text }], questions: [{ title: "Which environment?", options: ["Staging", "Production"] }, { title: "What deadline?" }] } },
});

test.each(["request_user_input", "functions.request_user_input"])("%s remains visible outside Activity, with every question and option description", name => {
  const messages = normaliseCodex([call(name)]);
  expect(messages[0]?.blocks[0]).toMatchObject({ kind: "tool", name, summary: "Which database?", questions: expected, result: null });
  const rows = readerRows(messages);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.activity).toBeUndefined();
  expect(rows[0]?.blocks[0]).toMatchObject({ questions: expected });
});

test("unknown tools, malformed inputs and model context never become question cards", () => {
  for (const row of [call("mcp.request_user_input"), call("other", { questions }), call("request_user_input", null), call("request_user_input", { questions: [null, 3, { question: 4 }] }),
    { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "text", text: JSON.stringify({ questions }) }] } },
    { type: "response_item", payload: { type: "function_call", name: "request_user_input", arguments: "invalid json" } }]) {
    const messages = normaliseCodex([row]);
    expect(messages.flatMap(message => message.blocks).some(block => block.kind === "tool" && block.questions?.length)).toBe(false);
  }
});

test("completed async questions display once and never claim the question message is still running", () => {
  const messages = normaliseCodex([asyncItem("Which environment?\n- Staging\n- Production\n\nWhat deadline?")]);
  expect(messages[0]?.blocks).toEqual([{ kind: "tool", name: "Question", summary: "Which environment?", outputUnavailable: true, result: null,
    questions: [{ text: "Which environment?", options: [{ label: "Staging" }, { label: "Production" }] }, { text: "What deadline?", options: [] }] }]);
  // A question message with distinct authored prose must retain that prose.
  expect(normaliseCodex([asyncItem("Please choose the deployment settings.")])[0]?.blocks[0]).toEqual({ kind: "text", text: "Please choose the deployment settings." });
  expect(normaliseCodex([asyncItem("Which environment?\n- Staging\n- Production\n\nWhat deadline?", "normal")])[0]?.blocks[0]?.kind).toBe("text");
  expect(normaliseCodex([{ type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", delivery: "async", content: [{ text: "- Staging" }], questions: [{ title: "", options: ["Staging"] }] } } }])[0]?.blocks[0]).toEqual({ kind: "text", text: "- Staging" });
});

test("object, array and IDE-prefixed async replies preserve the person's answer without machine wrappers", () => {
  const reply = { question: "Which environment?", answer: "Staging", questionItemId: JSON.stringify(["request_user_input_async", "async-call", 0]) };
  for (const value of [reply, [reply]]) {
    const envelope = `<send_user_message_question_reply>${JSON.stringify(value)}</send_user_message_question_reply>`;
    for (const text of [envelope, `# Context from my IDE setup:\n## Open files:\n- demo.ts\n\n## My request for Codex:\n${envelope}`]) {
      for (const row of [
        { type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "Text", text }] } } },
        { type: "event_msg", payload: { type: "user_message", message: text } },
      ]) expect(normaliseCodex([row])[0]).toMatchObject({ role: "you", blocks: [{ kind: "text", text: "Staging" }] });
    }
  }
  for (const value of [null, true, [{ answer: 3 }], { question: "Which environment?" }]) {
    const text = `<send_user_message_question_reply>${JSON.stringify(value)}</send_user_message_question_reply>`;
    expect(normaliseCodex([{ type: "event_msg", payload: { type: "user_message", message: text } }])).toEqual([]);
  }
  const quoted = 'Here is an example: <send_user_message_question_reply>{"answer":"Staging"}</send_user_message_question_reply>';
  expect(normaliseCodex([{ type: "event_msg", payload: { type: "user_message", message: quoted } }])[0]?.blocks[0]).toEqual({ kind: "text", text: quoted });
});

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });
test("indexed questions survive a distant answer append and pagination without losing their descriptions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shahi-codex-question-")); scratch.push(dir);
  const path = join(dir, "rollout.jsonl");
  const rows: Record<string, unknown>[] = [call(), ...Array.from({ length: 16 }, (_, n) => ({ type: "event_msg", payload: { type: "agent_message", message: `Step ${n}` } }))];
  writeFileSync(path, rows.map(row => JSON.stringify(row) + "\n").join(""));
  const pending = await readCodexWindow(path, { before: 1, limit: 1 });
  expect(pending.messages[0]?.blocks[0]).toMatchObject({ questions: expected, result: null });
  const output = { type: "response_item", payload: { type: "function_call_output", call_id: "input-call", output: JSON.stringify({ answers: { database: { answers: ["SQLite (Recommended)"] }, name: { answers: ["Demo"] } } }) } };
  appendFileSync(path, JSON.stringify(output) + "\n");
  const answered = await readCodexWindow(path, { before: 1, limit: 1 });
  expect(answered.messages).toEqual(normaliseCodex([...rows, output]).slice(0, 1));
  expect(answered.messages[0]?.blocks[0]).toMatchObject({ questions: expected, result: { text: output.payload.output } });
});

test("captured Codex 0.160 questions advance with one digit and refuse a stale first question", async () => {
  // Captured in an isolated herdr 0.9.3 session using a loopback model fixture.
  // Only the actual question region is stored; shell/account chrome is private.
  const first = readFileSync(new URL("../fixtures/blocked__codex-user-input-0.160-first__text.txt", import.meta.url), "utf8");
  const second = readFileSync(new URL("../fixtures/blocked__codex-user-input-0.160-second__text.txt", import.meta.url), "utf8");
  const shown = parsePrompt(first)!;
  expect(shown.question).toContain("Which fixture format should we use?");
  expect(shown.options).toHaveLength(4);
  expect(keysFor(shown, shown.options[1]!)).toEqual(["2"]);
  expect(keysFor(shown, shown.options[2]!)).toEqual(["3"]);
  expect(shown.options[2]?.textInput).toBeUndefined();
  let current = first;
  const writes: string[][] = [];
  const rpc = async (method: string, params: unknown) => {
    if (method === "pane.read") return { read: { text: current } };
    if (method === "pane.send_keys") { writes.push((params as { keys: string[] }).keys); current = second; }
  };
  expect(await answerPrompt(rpc, "fixture-pane", { ...shown.options[1]!, question: shown.question, context: shown.context }, { sleep: async () => {} })).toEqual(["2"]);
  expect(writes).toEqual([["2"]]);
  expect(parsePrompt(current)?.question).toContain("Which fixture timing should we use?");
  await expect(answerPrompt(rpc, "fixture-pane", { ...shown.options[1]!, question: shown.question, context: shown.context }, { sleep: async () => {} })).rejects.toMatchObject({ code: "prompt_changed" });
  expect(writes).toEqual([["2"]]);
});

const captured = (name: string) => readFileSync(new URL(`../fixtures/blocked__codex-user-input-0.160-${name}__text.txt`, import.meta.url), "utf8");
const blocked = { paneId: "fixture-pane", isAgent: true, status: "blocked", shellAlone: false };

test("Add notes presses Tab without answering, then Reader submits into the focused notes field", async () => {
  let screen = captured("single");
  const shown = parsePrompt(screen)!;
  const notes = shown.options.at(-1)!;
  expect(notes).toEqual({ index: 4, label: "Add notes", key: "Tab", selected: false, textInput: true });
  expect(keysFor(shown, notes)).toEqual(["Tab"]);
  const writes: unknown[] = [];
  const rpc = async (method: string, params: Record<string, unknown>) => {
    if (method === "pane.read") return { read: { text: screen } };
    writes.push({ method, params });
    if (method === "pane.send_keys" && (params.keys as string[])[0] === "Tab") screen = captured("notes-input");
    if (method === "pane.send_text") screen = captured("notes-typed");
  };
  await expect(submitPrompt(rpc, blocked, "Synthetic fixture note.", async () => {})).rejects.toMatchObject({ code: "prompt_open" });
  expect(writes).toEqual([]);
  expect(await answerPrompt(rpc, blocked.paneId, { ...notes, question: shown.question }, { settleMs: 0 })).toEqual(["Tab"]);
  const focused = parsePrompt(screen)!;
  expect(focused.context?.[0]).toContain("› 1. First");
  expect(focused.options).toEqual([{ index: 1, label: "Add notes", selected: true, textInput: true }]);
  expect(keysFor(focused, focused.options[0]!)).toEqual([]);
  expect(await submitPrompt(rpc, blocked, "Synthetic fixture note.", async () => {})).toBe("terminal");
  expect(writes).toEqual([
    { method: "pane.send_keys", params: { pane_id: blocked.paneId, keys: ["Tab"] } },
    { method: "pane.send_text", params: { pane_id: blocked.paneId, text: "Synthetic fixture note." } },
    { method: "pane.send_keys", params: { pane_id: blocked.paneId, keys: ["Enter"] } },
  ]);
});

test("custom Other notes stay focused, and only exact same-panel typing receives Enter", async () => {
  const before = captured("custom-input");
  const after = before.replace("› Add notes", "› Synthetic fixture note.");
  expect(parsePrompt(before)?.context?.at(-1)).toStartWith("› 3. None of the above");
  expect(codexNotesTyped(before, after, "Synthetic fixture note.")).toBe(true);
  const existing = captured("custom-existing-note");
  expect(codexNotesTyped(existing, captured("custom-typed"), " Synthetic fixture note.")).toBe(true);
  // Invisible trailing spaces or an edited cursor position cannot be inferred
  // from a terminal capture. Leave the typed text instead of guessing Enter.
  expect(codexNotesTyped(existing, captured("custom-typed"), "Synthetic fixture note.")).toBe(false);
  const unsafe = [
    after.replace("Which fixture format", "Which fixture timing"),
    after.replace("Question 1/1", "Question 2/2"),
    after.replace("    1. First", "  › 1. First").replace("  › 3.", "    3."),
    after.replace("› Synthetic fixture note.", "› Someone else typed."),
    captured("first"),
    after.replace("› Synthetic fixture note.", "› Synthetic fixture\n    note."),
  ];
  for (const moved of unsafe) {
    let screen = before;
    const writes: string[] = [];
    const rpc = async (method: string) => {
      if (method === "pane.read") return { read: { text: screen } };
      writes.push(method);
      if (method === "pane.send_text") screen = moved;
    };
    await expect(submitPrompt(rpc, blocked, "Synthetic fixture note.", async () => {})).rejects.toMatchObject({ code: "prompt_changed" });
    expect(writes).toEqual(["pane.send_text"]);
  }
  expect(codexNotesTyped(before, after, "Synthetic\nfixture note.")).toBe(false);
});

test("Codex notes recognition requires the complete measured footer, options and selection", () => {
  const before = captured("notes-input");
  for (const screen of [before.replace("tab or esc to clear notes", "Press enter"), before.replace("Question 1/1", "An example"), before.replace("› 1.", "1."), before.replace("3. None", "2. None"), before.replace("› Add notes", "Add notes")]) {
    expect(codexQuestionPrompt(screen.split("\n"))).toBeNull();
  }
  // A wrapped question may extend beyond the generic 25-line scan window.
  const long = before.replace("Which fixture format should we use?", Array.from({ length: 30 }, (_, n) => `Question context line ${n}`).join("\n"));
  expect(parsePrompt(long)?.options[0]?.textInput).toBe(true);
});
