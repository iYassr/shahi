/**
 * Reads the few bits of herdr's own config that the phone should honour.
 *
 * Specifically `ui.agent_panel_sort`, which is how herdr already orders its
 * agent panel: `"spaces"` groups by space, `"priority"` is an attention queue.
 * Someone who set that in their TUI has stated a preference, and the phone
 * defaulting to something else would be the app disagreeing with itself.
 *
 * Read rather than asked for: herdr's socket API can reload config
 * (`server.reload_config`) but cannot report it, so the file is the only source.
 * Failure is always soft — an unreadable or malformed config just means no
 * stated preference, never a broken dashboard.
 */
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_PATH =
  process.env.HERDR_CONFIG_PATH ?? join(homedir(), ".config", "herdr", "config.toml");

/** How the agent list is grouped. `agent` is ours; herdr has no equivalent. */
export type Grouping = "priority" | "space" | "agent";

/**
 * herdr's `ui.agent_panel_sort`, mapped onto our own names.
 *
 * herdr documents `"workspaces"` as an alias for `"spaces"`, so both map to the
 * same thing here.
 */
export async function readAgentPanelSort(path = CONFIG_PATH): Promise<Grouping | null> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch {
    // A config herdr itself would reject should not take the dashboard with it.
    return null;
  }

  const value = (parsed as { ui?: { agent_panel_sort?: unknown } })?.ui?.agent_panel_sort;
  if (typeof value !== "string") return null;

  switch (value.toLowerCase()) {
    case "spaces":
    case "workspaces":
      return "space";
    case "priority":
      return "priority";
    default:
      return null;
  }
}
