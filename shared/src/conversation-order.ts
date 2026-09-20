import type { DashboardPane } from "./index";

/** Unknown dates stay at the end; ties preserve the existing order. */
export function latestConversations(panes: readonly DashboardPane[], pins: ReadonlySet<string> = new Set()): DashboardPane[] {
  const time = (p: DashboardPane) => Number.isFinite(p.lastMessageAt) && p.lastMessageAt! > 0 ? p.lastMessageAt! : 0;
  return [...panes].sort((a, b) => Number(pins.has(b.paneId)) - Number(pins.has(a.paneId)) || time(b) - time(a));
}
