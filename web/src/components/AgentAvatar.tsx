import type { AgentStatus } from "../api";
import { AgentIcon, agentColor } from "./AgentIcon";

/** Identity, status dot, and working motion stay identical in Agents and Spaces. */
export function AgentAvatar({ kind, status, isAgent }: {
  kind: string | null | undefined;
  status: AgentStatus;
  isAgent: boolean;
}) {
  return <span className="agent-avatar" style={{ borderColor: agentColor(kind) }}
    data-status={status} data-working={status === "working"} role="img" aria-label={`${kind ?? (isAgent ? "agent" : "shell")}, ${status}`}>
    <span aria-hidden="true">{isAgent ? <AgentIcon kind={kind} size={20} /> : "❯"}</span>
  </span>;
}
