/** herdr 0.9 builds in staging and has no post-install hook. A bounded helper
 * waits for this build's marker in the registered checkout before restarting. */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { readEnvFile } from "../server/lib/secrets";

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

function command(args: string[]): string {
  const result = Bun.spawnSync(["herdr", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`herdr ${args.slice(0, 2).join(" ")} failed`);
  return result.stdout.toString();
}
function marker(root: string): string | null {
  try { return readFileSync(join(root, ".shahi-build"), "utf8").trim(); } catch { return null; }
}
async function main() {
  if (process.argv[2] === "finish") {
    const [root, build, dir, config, previousInstall] = process.argv.slice(3) as [string, string, string, string, string];
    // The installer must not move/delete our source before Bun has loaded it.
    writeFileSync(join(dir, "ready"), "ready");
    const env = readEnvFile(join(config, ".env"));
    const host = env.get("HOST") || "127.0.0.1";
    const local = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "[::1]" : host;
    const url = `http://${local}:${env.get("PORT") || "7171"}/api/meta`;
    await finishUpdate({
      installed: () => {
        if (marker(root) !== build) return false;
        // The directory move precedes registry commit. A failed install can
        // roll back in between; only act after herdr has registered it.
        try {
          const plugins = JSON.parse(command(["plugin", "list", "--json"])).result.plugins;
          const current = plugins.find((p: { plugin_id: string }) => p.plugin_id === "shahi");
          return current?.plugin_root === root && String(current.source?.installed_unix_ms) !== previousInstall;
        } catch { return false; }
      },
      restart: async () => { command(["plugin", "action", "invoke", "shahi.restart"]); },
      verified: async () => {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
          return res.ok && (await res.json() as { buildId?: string }).buildId === build;
        } catch { return false; }
      },
    });
    console.log("Shahi updated: the new build is running.");
    return;
  }
  const build = crypto.randomUUID();
  writeFileSync(".shahi-build", build + "\n");
  const plugins = JSON.parse(command(["plugin", "list", "--json"])).result.plugins as { plugin_id: string; plugin_root: string; source?: { installed_unix_ms?: number } }[];
  const previous = plugins.find(p => p.plugin_id === "shahi");
  if (!previous) return; // First installation is started by the startup/pair flow.
  const config = command(["plugin", "config-dir", "shahi"]).trim();
  const dir = mkdtempSync(join(tmpdir(), "shahi-update-"));
  const log = join(dir, "update.log");
  const fd = openSync(log, "a", 0o600);
  const child = spawn(process.execPath, [import.meta.path, "finish", previous.plugin_root, build, dir, config, String(previous.source?.installed_unix_ms)], {
    cwd: tmpdir(), detached: true, stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  child.unref();
  for (let i = 0; i < 100; i++) {
    if (existsSync(join(dir, "ready"))) {
      console.log(`Shahi will restart after installation and verify this build. Result: ${log}`);
      return;
    }
    await Bun.sleep(50);
  }
  throw new Error(`Could not start the update helper. See ${log}`);
}
if (import.meta.main) main().catch(error => { console.error(error.message); process.exitCode = 1; });
