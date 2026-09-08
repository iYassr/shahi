import type { DashboardPane } from "./index";

export type InboxKind = "reply" | "review" | "check";
export type Reviewed = Record<string, string>;

export function inboxKind(pane: DashboardPane): InboxKind | null {
  if (!pane.isAgent) return null;
  if (pane.status === "blocked") return "reply";
  if (pane.status === "done") return "review";
  if (pane.status === "unknown") return "check";
  return null;
}

// Kept in memory only. A changed result or another observed run needs a fresh review.
export function reviewKey(pane: DashboardPane): string {
  return JSON.stringify([pane.workspaceId, pane.tabId, pane.agent, pane.title, pane.preview]);
}
export function inboxPanes(panes: DashboardPane[], reviewed: Reviewed): DashboardPane[] {
  return panes.filter((pane) => {
    const kind = inboxKind(pane);
    return kind && (kind !== "review" || reviewed[pane.paneId] !== reviewKey(pane));
  }).sort((a, b) => ["reply", "check", "review"].indexOf(inboxKind(a)!) - ["reply", "check", "review"].indexOf(inboxKind(b)!));
}
export function retainReviews(reviewed: Reviewed, panes: DashboardPane[]): Reviewed {
  const next: Reviewed = {};
  for (const pane of panes) {
    if (pane.status === "done" && reviewed[pane.paneId] === reviewKey(pane)) next[pane.paneId] = reviewed[pane.paneId]!;
  }
  return Object.keys(next).length === Object.keys(reviewed).length ? reviewed : next;
}
