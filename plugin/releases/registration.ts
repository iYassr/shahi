/**
 * Whether herdr still has this plugin installed and enabled — the manager's
 * reason to exist.
 *
 * herdr has no uninstall or disable hook, and since releases moved into the
 * state directory the service needs nothing from the checkout that
 * `herdr plugin uninstall` deletes. So a plain uninstall or disable left a
 * relay-connected service with full control of the machine running, and
 * starting again at every login (pre-public-release review). The manager asks
 * herdr instead, and removes its own service when the answer is no.
 *
 * Removal must never follow an answer about some other herdr configuration.
 * `herdr plugin config-dir` resolves the same configuration root as
 * `plugin list`, for any id, installed or not (measured on herdr 0.9.1), so
 * the answer counts only when it names the directory this service was
 * installed from. Anything short of a clear answer is "unknown", and unknown
 * leaves the service running: a missing binary or a registry being rewritten
 * must not take a working install down.
 */
import { existsSync, realpathSync } from "node:fs";

export type Registration = "enabled" | "removed" | "unknown";
export type Command = (argv: string[]) => { ok: boolean; out: string };

export function run(argv: string[]): { ok: boolean; out: string } {
  try {
    const proc = Bun.spawnSync(argv, { stdout: "pipe", stderr: "ignore", timeout: 10_000 });
    return { ok: proc.exitCode === 0, out: proc.stdout.toString() };
  } catch {
    return { ok: false, out: "" };
  }
}

const canonical = (path: string) => { try { return realpathSync(path); } catch { return path; } };

export function registration(options: { herdr: string | null; pluginId: string; configDir: string; command?: Command }): Registration {
  const { herdr, pluginId, configDir, command = run } = options;
  if (!herdr || !configDir) return "unknown";
  const dir = command([herdr, "plugin", "config-dir", pluginId]);
  if (!dir.ok || canonical(dir.out.trim()) !== canonical(configDir)) return "unknown";
  const list = command([herdr, "plugin", "list", "--json"]);
  if (!list.ok) return "unknown";
  let plugins: unknown;
  try { plugins = (JSON.parse(list.out) as { result?: { plugins?: unknown } }).result?.plugins; } catch { return "unknown"; }
  if (!Array.isArray(plugins)) return "unknown";
  const entry = plugins.find((p: { plugin_id?: unknown }) => p?.plugin_id === pluginId) as { enabled?: unknown } | undefined;
  return !entry || entry.enabled === false ? "removed" : "enabled";
}

/**
 * The herdr the service was installed by (the hook's HERDR_BIN_PATH), else
 * whichever is on the service's PATH — a service rendered before this check
 * existed carries only the latter.
 */
export function herdrBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.HERDR_BIN_PATH && existsSync(env.HERDR_BIN_PATH)) return env.HERDR_BIN_PATH;
  return Bun.which("herdr", { PATH: env.PATH ?? "" });
}

/**
 * Two "removed" answers a few seconds apart. A reinstall rewrites the
 * registry, and removing a working install on one transient read would be
 * worse than a few seconds' delay.
 */
export async function confirmedRemoved(check: () => Registration, sleep = () => Bun.sleep(5_000)): Promise<boolean> {
  if (check() !== "removed") return false;
  await sleep();
  return check() === "removed";
}
