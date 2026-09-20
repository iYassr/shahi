import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWindow } from "./session-log";
import { summaryOf } from "./conversation-summary";
test("message time survives rereads and changes when a new chat message is appended", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shahi-chat-order-"));
  const path = join(dir, "messages.jsonl");
  const first = { type: "user", timestamp: "2026-09-20T01:00:00Z", message: { role: "user", content: "First message" } };
  const second = { type: "assistant", timestamp: "2026-09-20T02:00:00Z", message: { role: "assistant", content: [{ type: "text", text: "Latest reply" }] } };
  try {
    await writeFile(path, JSON.stringify(first) + "\n");
    const initial = summaryOf(await readWindow(path, { limit: 3 }));
    expect(initial.lastMessageAt).toBe(Date.parse(first.timestamp));
    expect(summaryOf(await readWindow(path, { limit: 3 }))).toEqual(initial);
    await writeFile(path, JSON.stringify(second) + "\n", { flag: "a" });
    const latest = summaryOf(await readWindow(path, { limit: 3 }));
    expect(latest.lastMessageAt).toBe(Date.parse(second.timestamp));
    expect(latest.preview).toBe("Latest reply");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("no transcript never invents a time from the clock or a fallback", () => {
  expect(summaryOf(null, Date.now())).toEqual({ preview: null, lastMessageAt: null });
});
