/**
 * What herdr says about one pane, read the way it holds true.
 *
 * Part of the herdr adapter: the fields here do not mean what their names
 * suggest on their own, and every reader of them should go through this module
 * rather than rediscover that.
 */
import type { PaneInfo } from "./herdr-schema";

/**
 * The session of the agent running in the pane now, or null.
 *
 * herdr keeps a pane's `agent_session` after the agent that reported it is
 * gone. Found in the pre-release bug hunt on herdr 0.9.1: restart herdr with
 * `resume_agents_on_restore = false`, or with an agent the restarted server
 * cannot find on its PATH (one installed through nvm), and the pane comes back
 * as a shell with `agent: null` and the old conversation's `agent_session`
 * still on it. Read on its own, that field served the dead conversation in the
 * reader and in the dashboard preview, with "Reply to this agent…" beneath it,
 * and the reply was typed into the shell as a command. A session counts only
 * while herdr reports the same agent running in the pane.
 */
export function agentSessionOf(pane: Pick<PaneInfo, "agent" | "agent_session"> | undefined): string | null {
  const session = pane?.agent_session;
  return pane?.agent && session?.agent === pane.agent ? session.value : null;
}
