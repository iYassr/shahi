import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { finishUpdate, helperStarted } from "./update";
import { installedEnvironment, launchdEnvironment, renderLaunchd, renderSystemd, systemdEnvironment, type ServiceSpec } from "./service";

const scratches: string[] = [];
const scratch = (prefix = "shahi-update-test-") => { const dir = mkdtempSync(join(tmpdir(), prefix)); scratches.push(dir); return dir; };
afterAll(() => { for (const dir of scratches) rmSync(dir, { recursive: true, force: true }); });

test("keeps the old service running until installation commits, then verifies the new process", async () => {
  let ticks = 0, restarts = 0;
  await finishUpdate({
    installed: () => ticks >= 2,
    restart: async () => { expect(ticks).toBe(2); restarts++; },
    verified: async () => ticks >= 4,
    sleep: async () => { ticks++; }, attempts: 5,
  });
  expect(restarts).toBe(1);
  expect(ticks).toBe(4);
});
test("failed installation never restarts the existing service", async () => {
  let restarts = 0;
  await expect(finishUpdate({ installed: () => false, restart: async () => { restarts++; },
    verified: async () => true, sleep: async () => {}, attempts: 2,
  })).rejects.toThrow("Installation did not finish");
  expect(restarts).toBe(0);
});
test("an old or unhealthy process cannot count as a successful update", async () => {
  await expect(finishUpdate({ installed: () => true, restart: async () => {},
    verified: async () => false, sleep: async () => {}, attempts: 2,
  })).rejects.toThrow("did not become ready");
});
test("a failed restart reports failure without claiming readiness", async () => {
  let verified = false;
  await expect(finishUpdate({ installed: () => true,
    restart: async () => { throw new Error("restart failed"); },
    verified: async () => { verified = true; return true; },
  })).rejects.toThrow("restart failed");
  expect(verified).toBe(false);
});
test("every update leaves no shahi-update directory behind, whether or not the helper answered", async () => {
  // Nothing removed the helper's handshake directory, so each update left one
  // in the temp directory (pre-public-release review).
  const answered = mkdtempSync(join(tmpdir(), "shahi-update-"));
  writeFileSync(join(answered, "ready"), "ready");
  expect(await helperStarted(answered, { sleep: async () => {} })).toBe(true);
  expect(existsSync(answered)).toBe(false);

  const silent = mkdtempSync(join(tmpdir(), "shahi-update-"));
  expect(await helperStarted(silent, { attempts: 3, sleep: async () => {} })).toBe(false);
  expect(existsSync(silent)).toBe(false);
});

/**
 * herdr 0.9.1 strips HERDR_SOCKET_PATH, HERDR_SESSION and HERDR_BIN_PATH
 * from build commands. The build step ran a bare `herdr` for everything, so
 * for a named session the restart went to the default socket and failed with
 * server_not_running (the old sidecar, a pre-managed one included, kept
 * running), and with herdr off PATH the spawn threw and failed the install
 * (pre-release bug hunt).
 */
describe("the install's build step, run as herdr runs it", () => {
  const spec = (home: string, config: string): ServiceSpec => ({
    bun: "/usr/bin/bun", root: join(home, "managed"), entry: "manager.js", logPath: join(home, "shahi.log"),
    env: { HERDR_SOCKET_PATH: join(home, ".config", "herdr", "sessions", "qa", "herdr.sock"), SHAHI_ENV_FILE: join(config, ".env"), PORT: "7171", PATH: "/usr/bin:/bin" },
  });

  test("the service's environment reads back from its plist and its unit, quotes and all", () => {
    const home = "/home/me w/a\"b&c";
    const s = spec(home, "/home/me/config");
    expect(launchdEnvironment(renderLaunchd(s))).toEqual(s.env);
    expect(systemdEnvironment(renderSystemd(s))).toEqual(s.env);
  });

  /** A computer with no herdr on PATH: HOME, PATH and the program that starts the step are all under our control. */
  function computer(service: boolean) {
    const dir = scratch();
    const home = join(dir, "home"), bin = join(dir, "bin"), config = join(dir, "config"), root = join(dir, "checkout");
    for (const d of [home, bin, config, root]) mkdirSync(d, { recursive: true });
    symlinkSync(process.execPath, join(bin, "bun"));
    const s = spec(home, config);
    if (service) {
      const file = process.platform === "darwin" ? join(home, "Library", "LaunchAgents", "app.shahi.sidecar.plist") : join(home, ".config", "systemd", "user", "shahi.service");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, process.platform === "darwin" ? renderLaunchd(s) : renderSystemd(s));
    }
    return { dir, home, bin, config, root, socket: s.env.HERDR_SOCKET_PATH! };
  }
  async function buildStep(c: ReturnType<typeof computer>, PATH = c.bin) {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "update.ts")], {
      cwd: c.root, env: { PATH, HOME: c.home }, stdout: "pipe", stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code, said: out + err };
  }

  test("a first install with herdr off PATH does not fail", async () => {
    const c = computer(false);
    const { code, said } = await buildStep(c);
    expect(said).not.toContain("Executable not found");
    expect(code).toBe(0);
    expect(existsSync(join(c.root, ".shahi-build"))).toBe(true);
  });

  test("a reinstall with herdr off PATH does not fail, and update.log says how to restart the session's Shahi", async () => {
    const c = computer(true);
    const { code, said } = await buildStep(c);
    expect(code).toBe(0);
    const log = readFileSync(join(c.config, "update.log"), "utf8");
    expect(log).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(log).toContain("herdr --session qa plugin action invoke shahi.restart");
    expect(said).toContain("herdr --session qa plugin action invoke shahi.restart");
  });

  /** A herdr that records every call and the socket it was given, with a registry that commits when told. */
  function fakeHerdr(c: ReturnType<typeof computer>, action = "exit 0") {
    const calls = join(c.dir, "calls.log");
    const herdr = join(c.bin, "herdr");
    const list = (ms: number) => JSON.stringify({ result: { plugins: [{ plugin_id: "shahi", plugin_root: c.root, source: { installed_unix_ms: ms } }] } });
    writeFileSync(herdr, `#!/bin/sh
printf '%s|%s\\n' "$HERDR_SOCKET_PATH" "$*" >> '${calls}'
case "$1 $2" in
  "plugin list") if [ -e '${join(c.dir, "committed")}' ]; then echo '${list(2)}'; else echo '${list(1)}'; fi ;;
  "plugin config-dir") echo '${c.config}' ;;
  "plugin action") ${action} ;;
esac
`);
    chmodSync(herdr, 0o755);
    return { herdr, calls: () => existsSync(calls) ? readFileSync(calls, "utf8") : "" };
  }
  /** The sidecar the restart brings up: it answers with whatever build the checkout now holds. */
  function sidecar(c: ReturnType<typeof computer>) {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ serverId: "s", buildId: readFileSync(join(c.root, ".shahi-build"), "utf8").trim() }) });
    writeFileSync(join(c.config, ".env"), `PORT=${server.port}\nSESSION_SECRET=${"k".repeat(43)}\n`);
    return server;
  }
  async function until(ok: () => boolean) {
    for (const end = Date.now() + 15_000; Date.now() < end && !ok();) await Bun.sleep(100);
    return ok();
  }

  test("a reinstall restarts Shahi through the named session its service follows, and verifies the build", async () => {
    const c = computer(true);
    const herdr = fakeHerdr(c);
    const server = sidecar(c);
    try {
      const { code, said } = await buildStep(c, `${c.bin}:/usr/bin:/bin`);
      expect(said).toContain("Shahi will restart after installation");
      expect(code).toBe(0);
      writeFileSync(join(c.dir, "committed"), "");
      expect(await until(() => existsSync(join(c.config, "update.log")) && readFileSync(join(c.config, "update.log"), "utf8").includes("verified"))).toBe(true);
      const restart = herdr.calls().split("\n").find(line => line.endsWith("plugin action invoke shahi.restart"));
      expect(restart).toBe(`${c.socket}|plugin action invoke shahi.restart`);
    } finally { server.stop(true); }
  }, 30_000);

  test("a restart herdr refuses is logged with herdr's reason, the time and the command that does it", async () => {
    const c = computer(true);
    fakeHerdr(c, `echo '{"error":{"code":"server_not_running","message":"no herdr server is running"}}' >&2; exit 1`);
    const server = sidecar(c);
    try {
      expect((await buildStep(c, `${c.bin}:/usr/bin:/bin`)).code).toBe(0);
      writeFileSync(join(c.dir, "committed"), "");
      const log = () => existsSync(join(c.config, "update.log")) ? readFileSync(join(c.config, "update.log"), "utf8") : "";
      expect(await until(() => log().includes("did not restart Shahi"))).toBe(true);
      expect(log()).toMatch(/^\d{4}-\d\d-\d\dT[^\n]* herdr at \S+qa\/herdr\.sock did not restart Shahi: no herdr server is running \(server_not_running\)\./m);
      expect(log()).toContain("herdr --session qa plugin action invoke shahi.restart");
      expect(log()).not.toContain("verified");
    } finally { server.stop(true); }
  }, 30_000);

  test("no service installed reads as nothing to read", () => {
    expect(installedEnvironment(process.platform, scratch())).toBeNull();
  });
});
