import { expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaneInfo } from "./herdr-schema";
import { transcriptPage, transcriptSourceFor, transcriptSummary, transcriptWatchSource } from "./conversation-summary";
import { findOpenCodeTranscript } from "./opencode-log";
import { createOpenCodeFixture, openCodeFixtureMessage, OPEN_CODE_SESSION } from "./opencode-log-fixtures";
import { watchTranscript } from "./transcript-watch";
import { readWindow } from "./session-log";

test("OpenCode WAL updates refresh cached pages, summaries and live invalidations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shahi-provider-cache-"));
  const path = join(dir, "opencode.db");
  const db = createOpenCodeFixture(path);
  let stop = () => {};
  try {
    openCodeFixtureMessage(db, "msg_first", "assistant", 1_800_000_000_000, [{ id: "prt_first", type: "text", text: "Starting" }]);
    const source = (await findOpenCodeTranscript(OPEN_CODE_SESSION, path))!;
    const first = (await transcriptPage("wal-pane", source, "opencode", {}))!;
    expect(first.log.messages[0]?.blocks).toEqual([{ kind: "text", text: "Starting" }]);
    expect(await transcriptPage("wal-pane", source, "opencode", {})).toBe(first);
    expect((await transcriptSummary("wal-pane", source, "opencode")).preview).toBe("Starting");
    const databaseSize = (await stat(path)).size;
    let changes = 0;
    stop = watchTranscript(transcriptWatchSource(source), () => changes++, { fallbackMs: 10 });
    await Bun.sleep(25);
    db.run("UPDATE part SET data=? WHERE id=?", [JSON.stringify({ type: "text", text: "Finished" }), "prt_first"]);
    for (let n = 0; n < 100 && !changes; n++) await Bun.sleep(10);
    expect(changes).toBeGreaterThan(0);
    // OpenCode commits through the WAL; the original DB need not grow at all.
    expect((await stat(path)).size).toBe(databaseSize);
    const latest = (await transcriptPage("wal-pane", source, "opencode", {}))!;
    expect(latest.log.messages[0]?.blocks).toEqual([{ kind: "text", text: "Finished" }]);
    expect(latest.etag).not.toBe(first.etag);
    expect((await transcriptSummary("wal-pane", source, "opencode")).preview).toBe("Finished");

    db.run("INSERT INTO session(id) VALUES (?)", ["ses_other"]);
    openCodeFixtureMessage(db, "msg_other", "assistant", 1_800_000_000_100, [{ type: "text", text: "Other session" }], "ses_other");
    const other = (await findOpenCodeTranscript("ses_other", path))!;
    const switched = (await transcriptPage("wal-pane", other, "opencode", {}))!;
    expect(switched.log.sessionId).toBe("ses_other");
    expect(switched.log.messages).toHaveLength(1);
    expect(switched.log.path).not.toBe(latest.log.path);
    expect(JSON.stringify(switched.log)).not.toContain("Finished");
  } finally { stop(); db.close(); await rm(dir, { recursive: true, force: true }); }
});

test("cached transcripts never cross providers, including an unknown agent with a session ID", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shahi-provider-boundary-"));
  const path = join(dir, "11111111-2222-4333-8444-555555555555.jsonl");
  try {
    await writeFile(path, JSON.stringify({ type: "user", message: { content: "Claude only" } }) + "\n");
    expect((await transcriptPage("provider-pane", path, "claude", {}))?.log.messages).toHaveLength(1);
    expect((await transcriptSummary("provider-pane", path, "claude")).preview).toBe("You: Claude only");
    expect(await transcriptPage("provider-pane", path, "unrecognized", {})).toBeNull();
    expect((await transcriptSummary("provider-pane", path, "unrecognized")).preview).toBeNull();
    const pane = { pane_id: "provider-pane", agent: "unrecognized", agent_session: { agent: "unrecognized", kind: "id", value: "11111111-2222-4333-8444-555555555555", source: "test" } } as PaneInfo;
    expect(await transcriptSourceFor(pane)).toBeNull();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("OpenCode undo and redo change the view identity while keeping the exact session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shahi-provider-undo-"));
  const path = join(dir, "opencode.db");
  const db = createOpenCodeFixture(path);
  try {
    for (let n = 0; n < 80; n++) openCodeFixtureMessage(db, `msg_${String(n).padStart(3, "0")}`, n % 2 ? "assistant" : "user", 1_800_000_000_000 + n, [{ type: "text", text: `Turn ${n}` }]);
    const source = (await findOpenCodeTranscript(OPEN_CODE_SESSION, path))!;
    const full = (await transcriptPage("undo-pane", source, "opencode", { limit: 20 }))!;
    expect(full.log.offset).toBe(60);
    db.run("UPDATE session SET revert=? WHERE id=?", [JSON.stringify({ messageID: "msg_020" }), OPEN_CODE_SESSION]);
    const undone = (await transcriptPage("undo-pane", source, "opencode", { limit: 20 }))!;
    expect(undone.log.total).toBe(20);
    expect(undone.log.offset).toBe(0);
    expect(undone.log.sessionId).toBe(full.log.sessionId);
    expect(undone.log.path).not.toBe(full.log.path);
    expect(undone.etag).not.toBe(full.etag);
    db.run("UPDATE session SET revert=NULL WHERE id=?", [OPEN_CODE_SESSION]);
    const redone = (await transcriptPage("undo-pane", source, "opencode", { limit: 20 }))!;
    expect(redone.log.total).toBe(80);
    expect(redone.log.path).not.toBe(undone.log.path);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test("Cursor pagination after index eviction invalidates the cached tail's old rewrite boundary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shahi-reader-eviction-"));
  const path = join(dir, "11111111-2222-4333-8444-555555555555.jsonl");
  try {
    await writeFile(path, Array.from({ length: 80 }, (_, n) => JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: `Cursor turn ${n}` }] } })).join("\n") + "\n");
    const first = (await transcriptPage("cursor-eviction", path, "cursor", { limit: 20 }))!;
    // Other opened conversations can evict the file index while a phone still
    // holds its conversation and the server still holds its cached tail page.
    for (let n = 0; n < 65; n++) {
      const other = join(dir, `${n}.jsonl`);
      await writeFile(other, JSON.stringify({ type: "user", message: { content: `Other ${n}` } }) + "\n");
      await readWindow(other);
    }
    const older = (await transcriptPage("cursor-eviction", path, "cursor", { limit: 20, before: 60 }))!;
    expect(older.log.path).not.toBe(first.log.path);
    const refreshed = (await transcriptPage("cursor-eviction", path, "cursor", { limit: 20 }))!;
    expect(refreshed.log.path).toBe(older.log.path);
    expect(refreshed.etag).not.toBe(first.etag);
    expect(refreshed.log.messages).toHaveLength(20);
    expect(refreshed.log.total).toBe(80);
    expect(JSON.stringify(refreshed.log.messages.at(-1))).toContain("Cursor turn 79");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
