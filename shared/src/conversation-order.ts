import type { DashboardPane } from "./index";

/** Starting a conversation counts before its first message. Unknown dates stay last; ties are stable. */
export function latestConversations(panes: readonly DashboardPane[], pins: ReadonlySet<string> = new Set()): DashboardPane[] {
  const valid = (at: number | null | undefined) => Number.isFinite(at) && at! > 0 ? at! : 0;
  const time = (p: DashboardPane) => Math.max(valid(p.lastMessageAt), valid(p.startedAt));
  return [...panes].sort((a, b) => Number(pins.has(b.paneId)) - Number(pins.has(a.paneId)) || time(b) - time(a));
}
