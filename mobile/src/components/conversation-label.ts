import { agentLabel, paneTitle, relativeTime, rowPreview, type DashboardPane } from "@shahi/shared";

// Shared with the web client, so the two cannot name one pane differently.
export { paneTitle };

/**
 * What VoiceOver reads for a whole conversation row.
 *
 * A pressable row merges its children into one element, so without a label of
 * its own it read the avatar's label and then the row's status word again —
 * "claude, working, Convert PDF…, working, …", heard on the simulator by the
 * September 2026 review. The title comes first because it is what tells two
 * agents apart; every other fact is said once.
 */
export function conversationLabel(pane: DashboardPane, where?: string | null, pinned = false, now = Date.now()): string {
  const title = paneTitle(pane);
  // A new agent is called by its kind until it names its conversation; once is enough.
  const kind = pane.isAgent ? agentLabel(pane.agent ?? "agent") : "shell";
  const said = pane.activity ? `${pane.activity.verb}… ${pane.activity.elapsed}` : rowPreview(pane);
  const at = rowAt(pane);
  return [title, kind === title ? null : kind, pane.status, where, said, at ? `last active ${relativeTime(at, now)}` : null, pinned ? "pinned" : null]
    .filter((part): part is string => !!part)
    .join(", ");
}

/**
 * When a row last moved: its latest message, or, before it has one, when it
 * started. Neither is known on an older computer, and then no time is shown
 * rather than one invented from a repaint (CLAUDE.md, conversation order).
 */
export function rowAt(pane: DashboardPane): number | null {
  return pane.lastMessageAt ?? pane.startedAt ?? null;
}
