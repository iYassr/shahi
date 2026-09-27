import { expect, test } from "bun:test";
import { latestConversations } from "./conversation-order";
import type { DashboardPane } from "./index";
const pane = (paneId: string, lastMessageAt?: number | null, status = "idle") => ({ paneId, lastMessageAt, status }) as DashboardPane;
test("newest message outranks agent status, and another message moves its chat up", () => {
  const items = [pane("waiting", 10, "blocked"), pane("new", 30), pane("working", 20, "working")];
  expect(latestConversations(items).map(p => p.paneId)).toEqual(["new", "working", "waiting"]);
  items[0]!.lastMessageAt = 40;
  expect(latestConversations(items).map(p => p.paneId)).toEqual(["waiting", "new", "working"]);
  expect(items.map(p => p.paneId)).toEqual(["waiting", "new", "working"]);
});
test("pins stay first and both sections sort by message time", () => {
  const items = [pane("a", 10), pane("b", 20), pane("c", 30), pane("d", 40)];
  expect(latestConversations(items, new Set(["a", "c"])).map(p => p.paneId)).toEqual(["c", "a", "d", "b"]);
});
test("old servers and missing or invalid dates retain stable positions after dated chats", () => {
  const items = [pane("old"), pane("none", null), pane("invalid", NaN), pane("negative", -1), pane("new", 10), pane("tie", 10)];
  expect(latestConversations(items).map(p => p.paneId)).toEqual(["new", "tie", "old", "none", "invalid", "negative"]);
});

test("new empty sessions appear ahead of older messages, below pins, then follow conversation activity", () => {
  const items = [pane("old", 20), pane("pinned", 5),
    { ...pane("claude", null), startedAt: 30 }, { ...pane("codex", null), startedAt: 40 }];
  const pins = new Set(["pinned"]);
  expect(latestConversations(items, pins).map(p => p.paneId)).toEqual(["pinned", "codex", "claude", "old"]);
  // A delayed first transcript may predate when we observed the launch. It
  // must not suddenly bury the conversation again.
  items[3]!.lastMessageAt = 35;
  expect(latestConversations(items, pins).map(p => p.paneId)).toEqual(["pinned", "codex", "claude", "old"]);
  items[0]!.lastMessageAt = 50;
  expect(latestConversations(items, pins).map(p => p.paneId)).toEqual(["pinned", "old", "codex", "claude"]);
});
