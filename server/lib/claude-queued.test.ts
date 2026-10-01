/**
 * Messages typed while Claude was working. Claude Code writes them as
 * `queued_command` attachments rather than user rows, and Reader dropped them:
 * 125 of 128 typed messages in the October 2026 census existed only there.
 * The shapes are the measured ones (Claude Code 2.1.286), with invented text.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalise, readSessionImage } from "./session-log";

const root = mkdtempSync(join(tmpdir(), "shahi-queued-"));
const previous = process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CONFIG_DIR = root;
afterAll(() => {
  if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

const queued = (attachment: Record<string, unknown>, uuid = `q-${Math.random()}`) => ({
  type: "attachment",
  uuid,
  timestamp: "2026-10-01T12:00:00.000Z",
  attachment: { type: "queued_command", source_uuid: "s", origin: { kind: "human" }, ...attachment },
});
const working = { type: "assistant", uuid: "a1", timestamp: "2026-10-01T11:59:59.000Z", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "make" } }] } };

test("a message typed while Claude was working is the person's message", () => {
  const messages = normalise([working, queued({ commandMode: "prompt", prompt: "also update the docs", humanTurn: true })]);
  expect(messages.at(-1)).toMatchObject({ role: "you", at: Date.parse("2026-10-01T12:00:00.000Z"), blocks: [{ kind: "text", text: "also update the docs" }] });
});

test("a background task's report delivered mid-turn is a notice tied to its call", () => {
  const report = "<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>completed</status>\n<summary>Agent \"Survey\" completed</summary>\n</task-notification>";
  const [message] = normalise([queued({ commandMode: "task-notification", prompt: report, origin: { kind: "task-notification" } })]);
  expect(message).toMatchObject({ role: "system", blocks: [{ kind: "text", notice: { status: "completed", toolUseId: "toolu_bg" } }] });
});

test("a message from another session is written for the model and stays out", () => {
  expect(normalise([queued({ commandMode: "prompt", prompt: "from a peer", isMeta: true, origin: { kind: "peer" } })])).toEqual([]);
});

test("other attachments and other queue modes are still not conversation", () => {
  expect(normalise([
    { type: "attachment", uuid: "x", attachment: { type: "task_reminder", content: [] } },
    queued({ commandMode: "bash", prompt: "ls" }),
    queued({ commandMode: "prompt", prompt: { text: "not a known shape" } }),
  ])).toEqual([]);
});

test("an image pasted into a queued message is shown and can be fetched", async () => {
  const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
  const row = queued({ commandMode: "prompt", prompt: [{ type: "text", text: "like this" }, { type: "image", source: { type: "base64", media_type: "image/png", data: png } }] }, "q-image");
  const [message] = normalise([row]);
  expect(message).toMatchObject({ role: "you", blocks: [{ kind: "text", text: "like this" }, { kind: "image", ref: "q-image:0" }] });

  const session = "0b7c3f8e-4a43-4a8c-9c2f-1d2e3f4a5b6c";
  mkdirSync(join(root, "projects", "p"), { recursive: true });
  writeFileSync(join(root, "projects", "p", `${session}.jsonl`), `${JSON.stringify(row)}\n`);
  const image = await readSessionImage(session, "q-image:0");
  expect(image?.mediaType).toBe("image/png");
  expect(Buffer.from(image!.bytes).toString("base64")).toBe(png);
});

test("a monitor's event, which has no status, is a notice and not tied to a call", () => {
  const event = "<task-notification>\n<task-id>m1</task-id>\n<tool-use-id>toolu_m</tool-use-id>\n<summary>Monitor event: build finished</summary>\n<event>exit 0</event>\n</task-notification>";
  const [message] = normalise([queued({ commandMode: "task-notification", prompt: event })]);
  expect(message).toMatchObject({ role: "system", blocks: [{ kind: "text", text: "Monitor event: build finished", notice: { status: "event" } }] });
  expect(message!.blocks[0]).not.toHaveProperty("notice.toolUseId");
});
