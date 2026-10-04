import { agentLabel, paneTitle, relativeTime, rowPreview, translate, type AppLocale, type DashboardPane } from "@shahi/shared";

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
export function conversationLabel(pane: DashboardPane, where?: string | null, pinned = false, now = Date.now(), locale: AppLocale = "en"): string {
  const title = paneTitle(pane);
  // A new agent is called by its kind until it names its conversation; once is enough.
  const kind = pane.isAgent ? (pane.agent ? agentLabel(pane.agent) : translate(locale, "agent")) : translate(locale, "shell");
  const said = pane.activity ? `${pane.activity.verb}… ${pane.activity.elapsed}` : pane.isAgent && !pane.preview ? translate(locale, "No messages yet") : rowPreview(pane);
  const at = rowAt(pane);
  return [title, kind === title ? null : kind, translate(locale, pane.status), where, said, at ? translate(locale, "last active {value0}", { value0: relativeTime(at, now, locale) }) : null, pinned ? translate(locale, "pinned") : null]
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
