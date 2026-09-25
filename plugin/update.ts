/**
 * The last build step of `herdr plugin install`. herdr 0.9 builds in staging
 * and has no post-install hook, so a bounded helper waits for this build's
 * marker in the registered checkout before restarting.
 *
 * herdr 0.9.1 runs build commands without HERDR_SOCKET_PATH, HERDR_SESSION
 * and HERDR_BIN_PATH (src/cli/plugin.rs), so this knows neither which herdr
 * to restart Shahi through nor where herdr is. It used to run a bare `herdr`
 * for both. For someone running a named session, that restart went to the
 * default socket and failed with server_not_running, leaving the old sidecar
 * running (a pre-managed 0.2.0 one included, below the API floor) with a bare
 * "herdr plugin action failed" in update.log; and with herdr off PATH, the
 * spawn threw and failed the whole install, a first one included (pre-release
 * bug hunt). So the session is the one the installed service follows, read
 * back from its unit or plist, and herdr is looked for where it is likely to be.
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, openSync, closeSync, statSync, renameSync, rmSync, readlinkSync, appendFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";
import { readEnvFile } from "../server/lib/secrets";
import { Auth } from "../server/lib/auth";
import { parsePort } from "../server/lib/config";
import { herdrCli } from "../server/lib/herdr-session";
import { readJson, installation } from "./releases/storage";
import { installedEnvironment } from "./service";
import { updateInProgress, type ControlHandshake } from "@shahi/shared";

export async function finishUpdate(options: {
  installed: () => boolean; restart: () => Promise<void>; verified: () => Promise<boolean>;
  sleep?: () => Promise<void>; attempts?: number;
}): Promise<void> {
  const sleep = options.sleep ?? (() => Bun.sleep(500));
  const attempts = options.attempts ?? 120;
  let installed = false;
  for (let i = 0; i < attempts; i++) {
    if (options.installed()) { installed = true; break; }
    await sleep();
  }
  if (!installed) throw new Error("Installation did not finish; the running service was left alone.");
  await options.restart();
  for (let i = 0; i < attempts; i++) {
    if (await options.verified()) return;
    await sleep();
  }
  throw new Error("The updated Shahi did not become ready. Check shahi.logs and retry shahi.restart.");
}

/**
 * Waits for the detached helper to say it has loaded, then removes the
 * handshake directory, whether it answered or not. Nothing removed it before,
 * so every update left a `shahi-update-*` directory in the temp directory
 * (pre-public-release review). Its only file is written before the helper
 * does anything else, so the helper never needs it afterwards.
 */
export async function helperStarted(dir: string, { attempts = 100, sleep = () => Bun.sleep(50) } = {}): Promise<boolean> {
  try {
    for (let i = 0; i < attempts; i++) {
      if (existsSync(join(dir, "ready"))) return true;
      await sleep();
    }
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One herdr CLI call: its output, or herdr's own reason for failing. Never a throw, which a missing binary used to be. */
export function herdrCall(herdr: string, args: string[], env: Record<string, string> = {}): { ok: boolean; out: string; reason: string } {
  try {
    const result = Bun.spawnSync([herdr, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env }, timeout: 30_000 });
    const out = result.stdout.toString();
    return { ok: result.exitCode === 0, out, reason: herdrReason(result.stderr.toString() || out) || `exit status ${result.exitCode}` };
  } catch (err) {
    return { ok: false, out: "", reason: err instanceof Error ? err.message : String(err) };
  }
}

/** herdr answers a failure with `{"error":{"code","message"}}`. */
function herdrReason(text: string): string {
  const said = text.trim();
  try {
    const error = (JSON.parse(said) as { error?: { code?: string; message?: string } }).error;
    if (error?.message) return error.code ? `${error.message} (${error.code})` : error.message;
  } catch { /* not herdr's JSON */ }
  return said.split("\n").at(-1) ?? "";
}

/** The program that ran this step: bun.sh execs bun, so that is `herdr plugin install` itself, wherever it lives. */
function parentHerdr(): string | null {
  let path = "";
  try {
    if (process.platform === "linux") path = readlinkSync(`/proc/${process.ppid}/exe`);
    else if (process.platform === "darwin") path = Bun.spawnSync(["/bin/ps", "-o", "comm=", "-p", String(process.ppid)], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
  } catch { return null; }
  return basename(path) === "herdr" ? path : null;
}

/**
 * herdr's binary: named by herdr (not to build steps, but by an older herdr
 * or by hand), named in the installed service, on PATH, the process that
 * started this build, or where herdr's own installer puts it.
 */
export function findHerdr({ env = process.env, service = null as Record<string, string> | null, parent = parentHerdr, home = homedir() } = {}): string | null {
  const candidates = [env.HERDR_BIN_PATH, service?.HERDR_BIN_PATH, Bun.which("herdr", { PATH: env.PATH ?? "" }), parent(), join(home, ".local", "bin", "herdr")];
  return candidates.find((path): path is string => !!path && isAbsolute(path) && existsSync(path)) ?? null;
}

/** What to do when the restart did not happen: nothing is lost, and herdr's next start does it anyway. */
export function restartAdvice(socket: string | undefined): string {
  return `Shahi keeps running what it runs now until herdr's next start, which restarts it with this install. To restart it now:  ${herdrCli(socket)} plugin action invoke shahi.restart`;
}

const stamp = (line: string) => `${new Date().toISOString()} ${line}`;

function marker(root: string): string | null {
  try { return readFileSync(join(root, ".shahi-build"), "utf8").trim(); } catch { return null; }
}

/** The detached helper: wait for herdr to commit this install, restart Shahi through the herdr its service follows, and check the result. */
async function finish([root, build, dir, config, previousInstall, herdr, socket]: string[]) {
  // The installer must not move/delete our source before Bun has loaded it.
  writeFileSync(join(dir!, "ready"), "ready");
  const env = readEnvFile(join(config!, ".env"));
  const host = env.get("HOST") || "127.0.0.1";
  const local = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "[::1]" : host;
  const url = `http://${local}:${parsePort(env.get("PORT"))}/api/meta`;
  const auth = new Auth({ passcodeHash: "", sessionSecret: env.get("SESSION_SECRET")!, sessionTtlMs: 60_000 });
  await finishUpdate({
    attempts: 360,
    installed: () => {
      if (marker(root!) !== build) return false;
      // The directory move precedes registry commit. A failed install can
      // roll back in between; only act after herdr has registered it.
      try {
        const listed = herdrCall(herdr!, ["plugin", "list", "--json"]);
        const plugins = JSON.parse(listed.out).result.plugins;
        const current = plugins.find((p: { plugin_id: string }) => p.plugin_id === "shahi");
        return current?.plugin_root === root && String(current.source?.installed_unix_ms) !== previousInstall;
      } catch { return false; }
    },
    restart: async () => {
      // Only this call goes to the service's herdr: the registry reads above
      // need no server, and must read the configuration this install wrote.
      const restarted = herdrCall(herdr!, ["plugin", "action", "invoke", "shahi.restart"], socket ? { HERDR_SOCKET_PATH: socket } : {});
      if (!restarted.ok) throw new Error(`herdr${socket ? ` at ${socket}` : ""} did not restart Shahi: ${restarted.reason}. ${restartAdvice(socket || undefined)}`);
    },
    verified: async () => {
      try {
        const managedRoot = readJson<string>(join(config!, "managed-root.json"));
        if (managedRoot) {
          const res = await fetch(url.replace("/api/meta", "/api/control/handshake"), { headers: { "x-shahi-control": "1", cookie: auth.cookie(auth.issue()).split(";")[0]! }, signal: AbortSignal.timeout(2000) });
          if (!res.ok) return false;
          const h = await res.json() as ControlHandshake;
          return h.buildId === installation(managedRoot)?.active.buildId && !updateInProgress(h.update.phase) && h.update.phase !== "failed" && !h.update.available;
        }
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        return res.ok && (await res.json() as { buildId?: string }).buildId === build;
      } catch { return false; }
    },
  });
  console.log(stamp("Shahi installation and running release verified."));
}

async function main() {
  if (process.argv[2] === "finish") return finish(process.argv.slice(3));
  const build = crypto.randomUUID();
  writeFileSync(".shahi-build", build + "\n");
  const service = installedEnvironment(process.platform, homedir());
  const herdr = findHerdr({ service });
  const listed = herdr ? herdrCall(herdr, ["plugin", "list", "--json"]) : null;
  let previous: { plugin_id: string; plugin_root: string; source?: { installed_unix_ms?: number } } | undefined;
  try {
    if (listed?.ok) previous = (JSON.parse(listed.out).result.plugins as NonNullable<typeof previous>[]).find(p => p.plugin_id === "shahi");
    else throw new Error(herdr ? `herdr plugin list failed: ${listed!.reason}` : "herdr is not on PATH, in the installed service, or in ~/.local/bin");
  } catch (err) {
    // A first install has nothing to restart: the pair popup or the next
    // herdr start sets it up. Only a service that is already there is owed
    // a word, which goes where its restarts are reported.
    if (!service) return;
    const said = stamp(`Could not restart Shahi after this install: ${err instanceof Error ? err.message : err}. ${restartAdvice(service.HERDR_SOCKET_PATH)}`);
    console.log(said);
    if (service.SHAHI_ENV_FILE) try { appendFileSync(join(dirname(service.SHAHI_ENV_FILE), "update.log"), said + "\n", { mode: 0o600 }); } catch { /* the build output has it */ }
    return;
  }
  if (!previous) return; // First installation is started by the startup/pair flow.
  const configDir = herdrCall(herdr!, ["plugin", "config-dir", "shahi"]);
  const config = configDir.ok ? configDir.out.trim() : service?.SHAHI_ENV_FILE ? dirname(service.SHAHI_ENV_FILE) : null;
  if (!config) throw new Error(`herdr plugin config-dir failed: ${configDir.reason}`);
  const dir = mkdtempSync(join(tmpdir(), "shahi-update-"));
  const log = join(config, "update.log");
  if (existsSync(log) && statSync(log).size > 64 * 1024) renameSync(log, log + ".1");
  const fd = openSync(log, "a", 0o600);
  const child = spawn(process.execPath, [import.meta.path, "finish", previous.plugin_root, build, dir, config, String(previous.source?.installed_unix_ms), herdr!, service?.HERDR_SOCKET_PATH ?? ""], {
    cwd: tmpdir(), detached: true, stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  child.unref();
  if (!await helperStarted(dir)) throw new Error(`Could not start the update helper. See ${log}`);
  console.log(`Shahi will restart after installation and verify this build. Result: ${log}`);
}
if (import.meta.main) main().catch(error => { console.error(stamp(error.message)); process.exitCode = 1; });
