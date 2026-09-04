import { argsForMode, type InstalledAgent } from "@shahi/shared";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type { InstalledAgent };

/**
 * Which agent kinds could actually start on this machine.
 *
 * herdr knows how to detect 19 (claude, codex, pi, gemini, cursor, droid, …),
 * but offering one that is not installed is worse than not offering it: nothing
 * fails until `agent.start` has waited its full readiness timeout for a process
 * that was never going to appear.
 *
 * Resolution goes through an **interactive** shell, not this process's `PATH`
 * and not a login shell either. Three environments, three different answers,
 * measured on this machine:
 *
 *   - the systemd service's own PATH  -> 2 of 4
 *   - `bash -lc` (login)              -> 2 of 4
 *   - `bash -ic` (interactive)        -> 4 of 4
 *
 * The gap is `~/.bashrc`, which is where nvm and tools with their own prefixes
 * put themselves, and which only an interactive shell sources. herdr gives each
 * pane an interactive shell, so that is the environment the question has to be
 * asked in — anything else under-reports and hides agents that would have
 * started perfectly well.
 */


/** Resolution is a shell spawn, so it is cached briefly rather than per request. */
const CACHE_TTL_MS = 60_000;

let cache: { at: number; agents: InstalledAgent[] } | undefined;

/**
 * Resolves each kind through an interactive shell.
 *
 * Kind names come from herdr's own manifest list and are matched against a
 * conservative pattern before being interpolated, so nothing shell-special can
 * reach the command line.
 */
export async function installedAgents(
  kinds: string[],
  now: () => number = Date.now,
): Promise<InstalledAgent[]> {
  if (cache && now() - cache.at < CACHE_TTL_MS) return cache.agents;

  const safe = kinds.filter((kind) => /^[a-z][a-z0-9_-]{0,31}$/i.test(kind));
  if (safe.length === 0) return [];

  // One shell, one line per resolved agent, so a slow profile is paid once.
  const script = safe
    .map((kind) => `p=$(command -v ${kind} 2>/dev/null) && printf '%s\\t%s\\n' ${kind} "$p"`)
    .join("; ");

  // `-i` is what sources ~/.bashrc; stderr is discarded because an interactive
  // shell without a tty complains about job control and says nothing useful.
  const shell = process.env.SHELL || "/bin/bash";
  // Bun 1.4's test runner can hand a piped child an invalid descriptor on
  // macOS (EBADF before posix_spawn starts). Redirect inside the shell to a
  // private temporary file instead; a supervised service has the same
  // detached-stdio shape, so this also makes discovery robust there.
  const scratch = mkdtempSync(join(tmpdir(), "shahi-agents-"));
  const output = join(scratch, "resolved");
  let stdout = "";
  try {
    Bun.spawnSync([shell, "-ic", `exec > \"$1\"; ${script}`, "shahi-agent-discovery", output], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    stdout = readFileSync(output, "utf8");
  } catch {
    // A missing or broken shell means no detected agents, not a failed API.
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const agents = stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((parts): parts is [string, string] => parts.length === 2 && Boolean(parts[1]))
    .map(([kind, command]) => ({ kind, command: command.trim() }))
    .sort((a, b) => a.kind.localeCompare(b.kind));

  cache = { at: now(), agents };
  return agents;
}

/** Drops the cache, so installing an agent does not require a restart to see. */
export function forgetInstalledAgents(): void {
  cache = undefined;
}

/**
 * Creates a tab and starts an agent in it.
 *
 * The two calls are one operation, and splitting them across the network was a
 * race: herdr answers `tab.create` as soon as the pane exists, but its shell
 * takes a moment more to come up, and `agent.start` against a pane that is not
 * yet a settled shell fails with `agent_pane_busy`. Seen on the phone, seconds
 * after creating a space — the tab appeared and the agent did not.
 *
 * So the wait belongs here, next to herdr, rather than in each client. Only
 * that one code is retried; anything else is a real failure and is raised.
 */
export async function startAgentInTab(
  rpc: <T>(method: string, params: unknown, options?: { timeoutMs?: number }) => Promise<T>,
  options: {
    workspaceId: string;
    cwd: string | null;
    label: string | null;
    kind: string;
    name: string;
    /**
     * How much the agent may do without asking, as a mode id rather than a
     * command line. Resolved here, so a client cannot pass arbitrary flags to a
     * process running as the user — the passcode is the boundary for what the
     * app may do, not for what any request may invent.
     */
    mode?: string | null;
  },
  wait: (ms: number) => Promise<unknown> = (ms) => Bun.sleep(ms),
): Promise<{ paneId: string; tabId: string | null }> {
  const created = await rpc<{ root_pane?: { pane_id: string }; tab?: { tab_id: string } }>(
    "tab.create",
    {
      workspace_id: options.workspaceId,
      label: options.label,
      cwd: options.cwd,
      focus: false,
    },
  );

  const paneId = created.root_pane?.pane_id;
  if (!paneId) throw new Error("herdr created the tab without telling us the pane");

  for (let attempt = 0; ; attempt++) {
    try {
      const args = argsForMode(options.kind, options.mode ?? null);
      await rpc(
        "agent.start",
        { pane_id: paneId, kind: options.kind, name: options.name, ...(args.length ? { args } : {}) },
        { timeoutMs: 310_000 },
      );
      return { paneId, tabId: created.tab?.tab_id ?? null };
    } catch (err) {
      const busy = err instanceof Error && err.message.includes("agent_pane_busy");
      if (!busy || attempt >= START_ATTEMPTS - 1) throw err;
      await wait(START_RETRY_MS);
    }
  }
}

/** Long enough for a shell to appear (~5s), short enough to still feel like one action. */
const START_ATTEMPTS = 10;
const START_RETRY_MS = 500;
