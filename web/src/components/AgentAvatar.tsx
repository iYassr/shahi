import { useLocale } from "../i18n";
import type { AgentStatus } from "../api";
import { AgentIcon, agentColor } from "./AgentIcon";

/** Identity, status dot, and working motion stay identical in Agents and Spaces. */
export function AgentAvatar({ kind, status, isAgent }: {
  kind: string | null | undefined;
  status: AgentStatus;
  isAgent: boolean;
}) {
  const { t } = useLocale();
  return <span className="agent-avatar" style={{ borderColor: agentColor(isAgent ? kind : "shell") }}
    data-status={status} data-working={status === "working"} role="img" aria-label={[kind ?? t(isAgent ? "Agent" : "Shell"), t(({ working: "Working", blocked: "Waiting", done: "Done", idle: "Idle", unknown: "Unknown" })[status])].join(", ")}>
    <span aria-hidden="true"><AgentIcon kind={isAgent ? kind : "shell"} size={20} /></span>
  </span>;
}
