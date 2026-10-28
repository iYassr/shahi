/**
 * The Claude Code configuration folder a running Claude process uses.
 *
 * `CLAUDE_CONFIG_DIR` belongs to each Claude process, not to the service. One
 * person can run two Claude accounts on one computer, each with its own
 * folder (`~/.claude` and `~/.claude-work`), in two panes of one herdr
 * session. Reader read only the service's folder, so a pane whose Claude ran
 * with the other one showed an empty Reader while Screen worked (issue #66).
 * So the folder is read from the pane's own Claude process, and the
 * service's folder is only the fallback.
 *
 * Linux exposes a process's starting environment in `/proc/<pid>/environ`,
 * readable by the same user. macOS has no such file: `ps -E` prints the
 * environment after the command, separated by spaces, so a value or argument
 * with a space cannot be told apart from the next variable. macOS stays on
 * the service's folder rather than parse that.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { claudeConfigDir } from "./session-log";

const NAME = "CLAUDE_CONFIG_DIR=";

/**
 * `CLAUDE_CONFIG_DIR` from a NUL-separated environment block, when it names
 * an absolute folder. A relative value would resolve against the Claude
 * process's working directory, which a pane can change at will, and an empty
 * one means Claude's default; both fall back.
 */
export function configDirFromEnviron(environ: string): string | null {
  for (const entry of environ.split("\0")) {
    if (!entry.startsWith(NAME)) continue;
    const value = entry.slice(NAME.length);
    return isAbsolute(value) ? normalize(value) : null;
  }
  return null;
}

/** The folder the process `pid` was started with, or null when it cannot be read. */
export async function processConfigDir(pid: number, procRoot = "/proc"): Promise<string | null> {
  if (process.platform !== "linux" && procRoot === "/proc") return null;
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    return configDirFromEnviron(await readFile(join(procRoot, String(pid), "environ"), "utf8"));
  } catch {
    return null;
  }
}

/** The Claude configuration folder of the process `pid`, else the service's own. */
export async function claudeConfigDirOf(pid: number | null | undefined): Promise<string> {
  return (pid ? await processConfigDir(pid) : null) ?? claudeConfigDir();
}
