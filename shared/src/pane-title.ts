import { agentCommand, agentLabel } from "./agent-label";

/**
 * What a conversation is called everywhere a client shows one: its terminal
 * title, or its pane id when there is none worth reading.
 *
 * A title can be only spaces. herdr omits a stripped title that strips to
 * nothing, and an older sidecar then passed the raw one on, so a row had no
 * name and was read aloud as "   , Claude, idle" (pre-release bug hunt). And
 * one helper for both clients and every screen, because the waiting card had
 * its own fallback, "untitled", for a pane its row called by its id.
 *
 * Until an agent names its conversation, the terminal's title is the command
 * line the shell ran, and new agents were listed as "claude --permission-mode
 * manual" and "codex --sandbox read-only --ask-for-approval o…" (simulator run
 * of build 32, October 2026). Such a title is the agent's name instead.
 */
export function paneTitle(pane: { title: string | null; paneId: string; agent?: string | null }): string {
  const title = pane.title?.trim();
  if (title && pane.agent && launchedBy(title, pane.agent)) return agentLabel(pane.agent);
  return title || pane.paneId;
}

/**
 * Whether a title is only the command that started this agent: its program,
 * by name or path, then nothing or flags. Flags are what Shahi and herdr add
 * (`--permission-mode`, `--resume`). Case and a following word are not
 * accepted, because "Claude Code" and "codex review notes" read as titles.
 */
function launchedBy(title: string, agent: string): boolean {
  const [program = "", next] = title.split(/\s+/);
  const name = program.slice(program.lastIndexOf("/") + 1);
  return (name === agent || name === agentCommand(agent)) && (next === undefined || next.startsWith("-"));
}

/** A home folder written the way a person writes it: "/Users/me/x" as "~/x". */
export function homePath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

/**
 * A conversation row's second line when nothing is happening in it: the last
 * thing said, or for an agent that has said nothing, that it has said nothing.
 * The full working folder used to stand in ("/Users/me/shahi-device-test/
 * claude-settings-error", build 28 audit), which said nothing the space tag
 * did not and pushed the row's meaning off the end. A shell, which has no
 * messages, keeps its folder, written from home.
 */
export function rowPreview(pane: { isAgent: boolean; preview: string | null; cwd: string | null }): string | null {
  if (pane.preview) return pane.preview;
  if (pane.isAgent) return "No messages yet";
  return pane.cwd ? homePath(pane.cwd) : null;
}
