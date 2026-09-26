import { agentLabel, argsForMode, type InstalledAgent } from "@shahi/shared";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError } from "./herdr-client";
import { refusedBeforeDelivery } from "./herdr-delivery";
import { OperationError } from "./operations";

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

/**
 * How long a user's shell may take to start before discovery gives up.
 *
 * Measured: `zsh -ic` with two `command -v` checks took 0.2-0.4s on a plain
 * setup, and nvm or oh-my-zsh profiles commonly take 1-3s. An rc file that
 * waits on the network can take forever, and the New Agent sheet is waiting.
 */
export const DISCOVERY_TIMEOUT_MS = 10_000;

let cache: { at: number; agents: InstalledAgent[] } | undefined;
/** Callers that arrive while a shell is already starting share its answer. */
let inflight: Promise<InstalledAgent[]> | undefined;

/**
 * Resolves each kind through an interactive shell.
 *
 * Kind names come from herdr's own manifest list and are matched against a
 * conservative pattern before being interpolated, so nothing shell-special can
 * reach the command line. That list is the same for every caller, which is
 * what lets concurrent callers share one discovery.
 */
export async function installedAgents(
  kinds: string[],
  now: () => number = Date.now,
  timeoutMs = DISCOVERY_TIMEOUT_MS,
): Promise<InstalledAgent[]> {
  if (cache && now() - cache.at < CACHE_TTL_MS) return cache.agents;
  inflight ??= discover(kinds, now, timeoutMs).finally(() => {
    inflight = undefined;
  });
  return inflight;
}

async function discover(kinds: string[], now: () => number, timeoutMs: number): Promise<InstalledAgent[]> {
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
  let scratch: string | undefined;
  let stdout = "";
  let finished = false;
  try {
    scratch = await mkdtemp(join(tmpdir(), "shahi-agents-"));
    const output = join(scratch, "resolved");
    // Asynchronous, and bounded. This was `spawnSync` with no timeout, and the
    // sidecar is one process: while the user's rc file ran, every HTTP
    // request, WebSocket heartbeat, relay frame and poll waited behind it, and
    // an rc that stalled hung the service outright (pre-release review).
    // SIGKILL because an interactive shell ignores SIGTERM.
    const child = Bun.spawn([shell, "-ic", `exec > \"$1\"; ${script}`, "shahi-agent-discovery", output], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    await child.exited;
    finished = child.signalCode === null;
    stdout = await readFile(output, "utf8");
  } catch {
    // A missing or broken shell means no detected agents, not a failed API.
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }

  const agents = stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((parts): parts is [string, string] => parts.length === 2 && Boolean(parts[1]))
    .map(([kind, command]) => ({ kind, command: command.trim() }))
    .sort((a, b) => a.kind.localeCompare(b.kind));

  // A shell that had to be killed answered nothing reliable: report what it
  // managed, but ask again next time rather than hide agents for a minute.
  if (finished) cache = { at: now(), agents };
  return agents;
}

/** Drops the cache, so installing an agent does not require a restart to see. */
export function forgetInstalledAgents(): void {
  cache = undefined;
}

/**
 * The agent certainly did not start, and the tab made for it has been closed.
 * Nothing it did is left behind, so a retry under the same request id may
 * run again rather than be handed this failure.
 */
export class AgentStartFailed extends OperationError {
  constructor(message: string) {
    super(message, 400);
  }
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

  // Display names are human text; herdr's control name is a lowercase identifier.
  // Keep the tab label intact, including spaces and non-Latin characters.
  const cleaned = options.name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const candidate = cleaned || options.kind;
  const baseName = (/^[a-z]/.test(candidate) ? candidate : `agent-${candidate}`).slice(0, 32);
  let name = baseName;
  const readyDeadline = Date.now() + 300_000;
  for (let attempt = 0; ; attempt++) {
    try {
      const args = argsForMode(options.kind, options.mode ?? null);
      const started = await rpc<{ agent?: { interactive_ready?: boolean; launch_pending?: boolean; agent_status?: string } }>(
        "agent.start",
        { pane_id: paneId, kind: options.kind, name, ...(args.length ? { args } : {}) },
        { timeoutMs: 310_000 },
      );
      // herdr 0.9.1 can acknowledge the launch before the composer is ready.
      // Keep this same pane while it starts, so the first message is not refused
      // with agent_not_ready and retrying never creates a duplicate session.
      // A permission/setup question must open immediately for the user to answer.
      let agent = started.agent;
      for (let checks = 0; agent?.agent_status !== "blocked" && (agent?.interactive_ready === false || agent?.launch_pending === true); checks++) {
        if (checks >= 600 || Date.now() >= readyDeadline) throw new Error("The agent is still starting. Open its conversation again in a moment.");
        await wait(500);
        agent = (await rpc<{ agent?: { interactive_ready?: boolean; launch_pending?: boolean; agent_status?: string } }>("agent.get", { target: paneId })).agent;
      }
      return { paneId, tabId: created.tab?.tab_id ?? null };
    } catch (err) {
      // Both clients default to the kind ("claude"). herdr names are global
      // across workspaces, so a second agent needs its own control identifier.
      // Retry in this same fresh pane: checking names before starting races
      // another phone, and creating another tab would leave an empty shell.
      if (err instanceof Error && err.message.includes("agent_name_taken") && attempt < START_ATTEMPTS - 1) {
        name = `${baseName.slice(0, 23)}-${crypto.randomUUID().slice(0, 8)}`;
        continue;
      }
      const busy = err instanceof Error && err.message.includes("agent_pane_busy");
      if (busy && attempt < START_ATTEMPTS - 1) {
        await wait(START_RETRY_MS);
        continue;
      }
      throw await undoCertainFailure(rpc, err, created.tab?.tab_id, options.kind);
    }
  }
}

/**
 * Closes the tab of a start that certainly failed, and says so in words.
 *
 * A failed start left its tab behind, an empty shell per attempt that
 * survived herdr restarts and sat in the space, and the phone showed herdr's
 * own text: "herdr agent.get failed [agent_not_found]: agent target w2:p2
 * not found" for an agent that exited while launching (pre-release bug hunt,
 * B81). Certain means herdr answered with a refusal made before it acted, or
 * that the agent it launched is gone. Anything else — a timeout, a lost
 * socket, a pane still busy, an agent still starting — may yet become an
 * agent, so its tab stays and the failure goes up unchanged.
 */
async function undoCertainFailure(
  rpc: <T>(method: string, params: unknown, options?: { timeoutMs?: number }) => Promise<T>,
  err: unknown,
  tabId: string | undefined,
  kind: string,
): Promise<unknown> {
  if (!(err instanceof HerdrError) || !refusedBeforeDelivery(err) || !tabId) return err;
  try {
    await rpc("tab.close", { tab_id: tabId });
  } catch {
    // The tab stays, and so does herdr's own account of what happened.
    return err;
  }
  const name = agentLabel(kind);
  return new AgentStartFailed(
    err.code === "agent_not_found" && err.method === "agent.get"
      ? `${name} exited while it was starting, so its tab was closed. Run it in a terminal in this space to see why.`
      : `herdr could not start ${name} (${err.code}), so its tab was closed.`,
  );
}

/** Long enough for a shell to appear (~5s), short enough to still feel like one action. */
const START_ATTEMPTS = 10;
const START_RETRY_MS = 500;
