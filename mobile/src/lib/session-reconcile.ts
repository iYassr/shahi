import type { Session } from "@shahi/shared";
export function reconcileArray<T>(prev: T[], next: T[], key: (t: T) => string): T[] {
  const prevByKey = new Map(prev.map((t) => [key(t), t] as const));
  // Reuse the previous object for any entry with byte-identical content,
  // wherever it now sits. Then keep the previous array only when the result is
  // element-for-element the same (same refs, same order) — that catches
  // insertions, removals and reorders without ever indexing prev out of
  // bounds, which is what crashed when `next` was longer than `prev`.
  const out = next.map((n) => {
    const old = prevByKey.get(key(n));
    return old && JSON.stringify(old) === JSON.stringify(n) ? old : n;
  });
  const unchanged = out.length === prev.length && out.every((v, i) => v === prev[i]);
  return unchanged ? prev : out;
}

export function reconcileSession(prev: Session | null, next: Session): Session {
  if (!prev) return next;
  const panes = reconcileArray(prev.panes, next.panes, (p) => p.paneId);
  const tabs = reconcileArray(prev.tabs, next.tabs, (t) => t.tabId);
  const workspaces = reconcileArray(prev.workspaces, next.workspaces, (w) => w.workspaceId);
  // Scalar fields (version, protocol, grouping, focus) rarely move; compare them
  // together, and if they and all three lists are unchanged, keep the previous
  // Session so nothing downstream re-renders.
  const scalarsSame =
    prev.version === next.version &&
    prev.protocol === next.protocol &&
    prev.serverName === next.serverName &&
    prev.defaultGrouping === next.defaultGrouping &&
    prev.focusedPaneId === next.focusedPaneId;
  if (scalarsSame && panes === prev.panes && tabs === prev.tabs && workspaces === prev.workspaces) {
    return prev;
  }
  return { ...next, panes, tabs, workspaces };
}

