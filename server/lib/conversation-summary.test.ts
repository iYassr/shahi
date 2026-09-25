import { expect, setSystemTime, test } from "bun:test";
import { appendFile, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrClient } from "./herdr-client";
import type { PaneInfo } from "./herdr-schema";
import { readWindow } from "./session-log";
import { conversationSummary, retainSummaries, summaryOf, transcriptPage, transcriptPathFor, transcriptSummary } from "./conversation-summary";
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

// Every connected dashboard summarises every pane every 3s. Through the
// readers' 64-transcript index caches, a session with more agent panes than
// that evicted each round the indexes the same round needed next, and every
// eviction was a full parse of a transcript (review finding, September 2026).
test("a dashboard over more agent panes than the reader's index holds re-reads no unchanged transcript", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shahi-many-panes-"));
  const panes = Array.from({ length: 70 }, (_, n) => ({ paneId: `w1:p${n}`, path: join(dir, `${n}.jsonl`) }));
  // A whole-millisecond time, so the probe below can put it back exactly.
  const settled = new Date("2026-09-20T03:00:00Z");
  const reply = (text: string) =>
    JSON.stringify({ type: "assistant", uuid: text, timestamp: "2026-09-20T02:00:00Z", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";
  const round = () => Promise.all(panes.map(({ paneId, path }) => transcriptSummary(paneId, path)));
  try {
    for (const { path } of panes) { await writeFile(path, reply("reply A")); await utimes(path, settled, settled); }
    const first = await round();
    expect(new Set(first.map((summary) => summary.preview))).toEqual(new Set(["reply A"]));
    // Different bytes behind the same inode, size and modification time: a
    // round that reads any transcript would show them.
    for (const { path } of panes) { await writeFile(path, reply("reply B")); await utimes(path, settled, settled); }
    expect(await round()).toEqual(first);
    await appendFile(panes[0]!.path, reply("reply C"));
    expect((await round())[0]!.preview).toBe("reply C");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a pane's summary follows it to another transcript and is forgotten when it closes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shahi-summary-panes-"));
  const settled = new Date("2026-09-20T03:00:00Z");
  const write = async (path: string, text: string) => {
    await writeFile(path, JSON.stringify({ type: "user", timestamp: "2026-09-20T01:00:00Z", message: { role: "user", content: text } }) + "\n");
    await utimes(path, settled, settled);
  };
  const [a, b, c] = ["a", "b", "c"].map((name) => join(dir, `${name}.jsonl`)) as [string, string, string];
  try {
    await write(a, "first chat");
    await write(b, "second one");
    await write(c, "other pane");
    expect((await transcriptSummary("w1:p1", a)).preview).toBe("You: first chat");
    expect((await transcriptSummary("w1:p1", b)).preview).toBe("You: second one");
    expect((await transcriptSummary("w1:p2", c)).preview).toBe("You: other pane");
    retainSummaries(["w1:p1"]);
    await write(c, "reopened!!");
    expect((await transcriptSummary("w1:p2", c)).preview).toBe("You: reopened!!");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a Cursor summary, which has no message times, is dated by its transcript", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shahi-summary-cursor-"));
  const path = join(dir, "11111111-2222-4333-8444-555555555555.jsonl");
  const settled = new Date("2026-09-20T03:00:00Z");
  try {
    await writeFile(path, JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "done" }] } }) + "\n");
    await utimes(path, settled, settled);
    expect(await transcriptSummary("w1:p9", path, "cursor")).toEqual({ preview: "done", lastMessageAt: settled.getTime() });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// The reader polls its page every 2.5s. Each poll read the page's byte range
// and parsed it again, large rows and all, and only then compared ETags: the
// pre-release bug hunt watched memory climb from 38 to 138MB over 12 polls of
// a page holding 20 screenshots, and to ~415MB with one 30MB tool result.
test("an unchanged transcript's page is answered without reading it again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shahi-page-"));
  const path = join(dir, "11111111-2222-4333-8444-555555555555.jsonl");
  const settled = new Date("2026-09-20T03:00:00Z");
  const reply = (uuid: string, text: string) =>
    JSON.stringify({ type: "assistant", uuid, timestamp: "2026-09-20T02:00:00Z", message: { content: [{ type: "text", text }] } }) + "\n";
  const texts = (page: Awaited<ReturnType<typeof transcriptPage>>) => page!.log.messages.map((m) => (m.blocks[0] as { text: string }).text);
  try {
    await writeFile(path, reply("a", "reply A") + reply("b", "reply B"));
    await utimes(path, settled, settled);
    const first = await transcriptPage("w1:p1", path, "claude", { limit: 60 });
    expect(texts(first)).toEqual(["reply A", "reply B"]);
    expect(first!.log.sessionId).toBe("11111111-2222-4333-8444-555555555555");

    // Different bytes behind the same inode, size and modification time: a
    // poll that read the file would show them.
    await writeFile(path, reply("a", "reply X") + reply("b", "reply Y"));
    await utimes(path, settled, settled);
    const again = await transcriptPage("w1:p1", path, "claude", { limit: 60 });
    expect(again).toBe(first);
    // Another window of the same transcript is a page of its own.
    expect(texts(await transcriptPage("w1:p1", path, "claude", { limit: 1, before: 1 }))).toEqual(["reply X"]);
    expect(await transcriptPage("w1:p1", path, "claude", { limit: 60 })).toBe(first);

    await appendFile(path, reply("c", "reply C"));
    const grown = await transcriptPage("w1:p1", path, "claude", { limit: 60 });
    expect(texts(grown)).toEqual(["reply X", "reply Y", "reply C"]);
    expect(grown!.etag).not.toBe(first!.etag);

    // Kept only for panes that exist.
    retainSummaries([]);
    await writeFile(path, reply("a", "reply 1") + reply("b", "reply 2") + reply("c", "reply 3"));
    await utimes(path, settled, settled);
    expect(texts(await transcriptPage("w1:p1", path, "claude", { limit: 60 }))).toEqual(["reply 1", "reply 2", "reply 3"]);
    // A transcript that is not there is no page, not an error.
    expect(await transcriptPage("w1:p1", join(dir, "gone.jsonl"), "claude", { limit: 60 })).toBeNull();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Each dashboard build asked every Codex and Cursor pane's process which
// transcript it had open, a herdr call and an lsof per pane, before the summary
// cache was consulted. Twenty such panes cost twenty lsof runs every 3s, and one
// pane retitling itself twice a second drove 680 in 15s (pre-release bug hunt).
test("dashboard builds do not ask a Codex or Cursor pane's process for its transcript every time", async () => {
  for (const agent of ["codex", "cursor"]) {
    let asked = 0;
    const client = {
      rpc: async (method: string) => {
        if (method === "pane.process_info") asked++;
        return { process_info: { foreground_processes: [] } };
      },
    } as unknown as HerdrClient;
    const pane = {
      pane_id: `w9:${agent}`, workspace_id: "w9", tab_id: "t9", terminal_id: "x", revision: 0, focused: false,
      agent, agent_status: "idle", agent_session: null, cwd: "/tmp", terminal_title: "one",
    } as PaneInfo;
    try {
      await conversationSummary(pane, client);
      await conversationSummary({ ...pane, terminal_title: "retitled" }, client);
      expect(asked).toBe(1);
      // A turn starting is when a first transcript appears or a process moves on.
      await conversationSummary({ ...pane, agent_status: "working" }, client);
      expect(asked).toBe(2);
      // The reader and the transcript watcher look afresh, and the dashboard
      // reuses what they found.
      await transcriptPathFor(pane, client);
      expect(asked).toBe(3);
      await conversationSummary(pane, client);
      expect(asked).toBe(3);
      // Nothing is trusted for long.
      setSystemTime(new Date(Date.now() + 16_000));
      await conversationSummary(pane, client);
      expect(asked).toBe(4);
      // And nothing is kept for a pane that closed.
      retainSummaries([]);
      await conversationSummary(pane, client);
      expect(asked).toBe(5);
    } finally { setSystemTime(); }
  }
});
