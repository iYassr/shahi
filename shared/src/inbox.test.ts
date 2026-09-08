import { expect, test } from "bun:test";
import type { DashboardPane } from "./index";
import { inboxPanes, retainReviews, reviewKey } from "./inbox";
const pane = (paneId: string, status: DashboardPane["status"]): DashboardPane => ({ paneId, status, workspaceId: "w", workspaceLabel: "project", tabId: paneId, agent: "codex", title: "Task", cwd: null, focused: false, hasPrompt: false, isAgent: true, prompt: null, preview: "Result", activity: null });
test("inbox prioritizes requests, uncertain status, and unreviewed results; excludes running agents and shells", () => {
  const done = pane("done", "done");
  const input = [done, pane("working", "working"), pane("waiting", "blocked"), pane("unknown", "unknown"), { ...pane("shell", "unknown"), isAgent: false }];
  expect(inboxPanes(input, {}).map(p => p.paneId)).toEqual(["waiting", "unknown", "done"]);
  expect(inboxPanes(input, { done: reviewKey(done) }).map(p => p.paneId)).toEqual(["waiting", "unknown"]);
});
test("review survives identical snapshots but a new result or observed run reopens it", () => {
  const done = pane("done", "done");
  const reviewed = { done: reviewKey(done) };
  expect(retainReviews(reviewed, [structuredClone(done)])).toBe(reviewed);
  expect(inboxPanes([{ ...done, preview: "New result" }], reviewed)).toHaveLength(1);
  expect(retainReviews(reviewed, [{ ...done, status: "working" }])).toEqual({});
  expect(retainReviews(reviewed, [])).toEqual({});
});
