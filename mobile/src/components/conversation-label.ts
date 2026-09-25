import { agentLabel, type DashboardPane } from "@shahi/shared";

/**
 * What a conversation is called everywhere it appears: its terminal title, or
 * its pane id when there is none worth reading. A title can be only spaces —
 * herdr omits one that strips to nothing, and the sidecar then passes the raw
 * one on — and that gave a row with no name, read aloud as "   , Claude, idle"
 * (pre-release bug hunt). One helper, because the waiting card had its own
 * fallback, "untitled", for a pane its row called by its id.
 */
export function paneTitle(pane: Pick<DashboardPane, "title" | "paneId">): string {
  return pane.title?.trim() || pane.paneId;
}

/**
 * What VoiceOver reads for a whole conversation row.
 *
 * A pressable row merges its children into one element, so without a label of
 * its own it read the avatar's label and then the row's status word again —
 * "claude, working, Convert PDF…, working, …", heard on the simulator by the
 * September 2026 review. The title comes first because it is what tells two
 * agents apart; every other fact is said once.
 */
export function conversationLabel(pane: DashboardPane, where?: string | null, pinned = false): string {
  const kind = pane.isAgent ? agentLabel(pane.agent ?? "agent") : "shell";
  const said = pane.activity ? `${pane.activity.verb}… ${pane.activity.elapsed}` : pane.preview ?? pane.cwd;
  return [paneTitle(pane), kind, pane.status, where, said, pinned ? "pinned" : null]
    .filter((part): part is string => !!part)
    .join(", ");
}
