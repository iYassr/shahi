import type { InstalledAgent } from "@herdrui/shared";

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
  const proc = Bun.spawn([shell, "-ic", script], { stdout: "pipe", stderr: "ignore" });
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

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
