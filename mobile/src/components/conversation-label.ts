import { agentLabel, type DashboardPane } from "@shahi/shared";

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
  return [pane.title ?? pane.paneId, kind, pane.status, where, said, pinned ? "pinned" : null]
    .filter((part): part is string => !!part)
    .join(", ");
}
