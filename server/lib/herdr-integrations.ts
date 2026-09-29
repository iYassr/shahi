/**
 * herdr's agent integrations, kept installed for the agents Reader follows.
 *
 * Reader finds a conversation by the session id the agent reports to herdr,
 * and an agent reports it only through herdr's integration hook. Without one
 * herdr still detects the agent from its terminal, so a pane looked like a
 * Claude and Reader stayed empty: a TestFlight tester's conversations never
 * appeared (2026-09-28), and the only remedy was a command to type on the
 * computer. So the service installs the integration of each agent Reader
 * supports that can run here, and updates the ones herdr reports outdated.
 *
 * It is the service's job rather than the plugin's startup hook because the
 * service is what "Update computer" replaces; the hook comes from the plugin
 * checkout, which only a plugin reinstall does. And the service restarts on
 * every herdr start, so an agent installed later is picked up then.
 *
 * A missing integration is installed once. One this computer has had and no
 * longer has was removed by someone, and putting it back on every start would
 * overrule them, so every integration seen installed is remembered.
 *
 * `herdr integration install` is herdr's own installer: measured on 0.9.1, it
 * writes the hook script and adds it to the agent's settings, keeps the keys
 * already there, and asks nothing. The hook fires when a session starts, so a
 * conversation already running becomes readable the next time it starts.
 */
import { agentLabel } from "@shahi/shared";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicJson, readJson } from "../../plugin/releases/storage";

/** herdr's agent kind, and the integration that reports its session. */
export const READER_INTEGRATIONS: Record<string, string> = {
  claude: "claude",
  codex: "codex",
  cursor: "cursor",
  opencode: "opencode",
  agy: "antigravity-cli",
};

export type IntegrationState = "missing" | "current" | "outdated";

/**
 * `herdr integration status` prints one line per integration, measured on
 * 0.9.1: `claude: outdated (v9 < v10) (/path)`, `codex: current (v8) (/path)`,
 * `letta (experimental): not installed (/path)`. Any other line is skipped,
 * and an integration it does not list is left alone.
 */
export function parseIntegrationStatus(text: string): Map<string, IntegrationState> {
  const states = new Map<string, IntegrationState>();
  for (const line of text.split("\n")) {
    const match = /^([a-z][a-z0-9-]*)(?: \([^)]*\))?: (not installed|current|outdated)\b/.exec(line.trim());
    if (match) states.set(match[1]!, match[2] === "not installed" ? "missing" : (match[2] as IntegrationState));
  }
  return states;
}

export interface HerdrCliResult { ok: boolean; out: string; reason: string }

export interface IntegrationDeps {
  /** One herdr CLI call, which never rejects. */
  herdr(args: string[]): Promise<HerdrCliResult>;
  /** Which of these agent kinds can start on this computer. */
  installed(kinds: string[]): Promise<string[]>;
  /** The integrations this computer has been seen with. */
  seenPath: string;
}

/**
 * What it did, as lines for the service's log. Never rejects: Reader is not
 * a reason for the service to fail.
 */
export async function keepReaderIntegrations(deps: IntegrationDeps): Promise<string[]> {
  const status = await deps.herdr(["integration", "status"]);
  if (!status.ok) return [`Could not check herdr's agent integrations: ${status.reason}`];
  const states = parseIntegrationStatus(status.out);
  let seen: Set<string>;
  try { seen = new Set(readJson<string[]>(deps.seenPath) ?? []); } catch { seen = new Set(); }
  const known = seen.size;

  const stateOf = (kind: string) => states.get(READER_INTEGRATIONS[kind]!);
  const kinds = Object.keys(READER_INTEGRATIONS).filter((kind) => stateOf(kind));
  for (const kind of kinds) if (stateOf(kind) !== "missing") seen.add(READER_INTEGRATIONS[kind]!);
  const outdated = kinds.filter((kind) => stateOf(kind) === "outdated");
  const absent = kinds.filter((kind) => stateOf(kind) === "missing" && !seen.has(READER_INTEGRATIONS[kind]!));
  // Which agents can run costs an interactive shell (agents.ts), so it is
  // asked only when there is something to install. An agent that is not here
  // gets no settings directory made for it.
  const present = new Set(absent.length ? await deps.installed(absent).catch(() => []) : []);

  const lines: string[] = [];
  for (const kind of [...outdated, ...absent.filter((kind) => present.has(kind))]) {
    const target = READER_INTEGRATIONS[kind]!;
    const name = agentLabel(kind);
    const done = await deps.herdr(["integration", "install", target]);
    if (!done.ok) {
      lines.push(`Could not install herdr's ${name} integration: ${done.reason}. Reader cannot identify ${name} conversations without it.`);
      continue;
    }
    seen.add(target);
    lines.push(outdated.includes(kind)
      ? `Updated herdr's ${name} integration.`
      : `Installed herdr's ${name} integration, so Reader can identify ${name} conversations. One already running becomes readable the next time it starts.`);
  }
  if (seen.size !== known) {
    try { atomicJson(deps.seenPath, [...seen].sort()); } catch { /* the next start records it */ }
  }
  return lines;
}

/**
 * Runs the herdr CLI. Asynchronous and bounded, because the service is one
 * process and every request would wait behind a synchronous spawn; output
 * through a file rather than a pipe, for the reason `installedAgents` gives.
 */
export async function herdrCli(bin: string, args: string[], timeoutMs = 30_000): Promise<HerdrCliResult> {
  let scratch: string | undefined;
  try {
    scratch = await mkdtemp(join(tmpdir(), "shahi-herdr-"));
    const output = join(scratch, "out");
    const child = Bun.spawn(["/bin/sh", "-c", 'out="$1"; shift; exec "$@" > "$out" 2>&1', "shahi-herdr", output, bin, ...args], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    const code = await child.exited;
    const out = await readFile(output, "utf8").catch(() => "");
    const first = out.split("\n").find((line) => line.trim())?.trim().slice(0, 200);
    return { ok: code === 0, out, reason: first || (child.signalCode ? `herdr did not answer within ${timeoutMs / 1000}s` : `exit status ${code}`) };
  } catch (err) {
    return { ok: false, out: "", reason: err instanceof Error ? err.message : String(err) };
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
