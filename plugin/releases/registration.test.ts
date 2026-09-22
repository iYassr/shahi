/**
 * `herdr plugin uninstall shahi` (or `disable`) used to leave Shahi running,
 * relay-connected and restarting at every login, because the service no
 * longer needs anything from the checkout herdr deletes and nothing asked
 * herdr whether the plugin was still there (pre-public-release review).
 *
 * The manager runs here for real, against a fake herdr, and against fake
 * `launchctl` and `systemctl` that are the only programs on its PATH, with
 * HOME in a scratch directory: it cannot reach this machine's real service.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Auth } from "../../server/lib/auth";
import { layoutFromEnv } from "../layout";
import { launchd, systemd } from "../service";
import { serviceSpec } from "../shahi";
import { confirmedRemoved, registration, type Command } from "./registration";
import { atomicJson } from "./storage";
import type { Release } from "./catalog";

const roots: string[] = [];
function scratch() { const root = mkdtempSync(join(tmpdir(), "shahi-registration-")); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const list = (plugins: object[]) => JSON.stringify({ id: "cli:plugin", result: { plugins, type: "plugin_list" } });
function herdr(configDir: string, answer: { ok?: boolean; out: string }, resolved = configDir): Command {
  return (argv) => argv[2] === "config-dir" ? { ok: true, out: `${resolved}\n` } : { ok: answer.ok ?? true, out: answer.out };
}

describe("whether herdr still has the plugin", () => {
  const configDir = "/home/me/.config/herdr/plugins/config/shahi";
  const ask = (command: Command) => registration({ herdr: "/usr/local/bin/herdr", pluginId: "shahi", configDir, command });

  test("an installed, enabled plugin keeps its service", () => {
    expect(ask(herdr(configDir, { out: list([{ plugin_id: "shahi", enabled: true }]) }))).toBe("enabled");
  });

  test("a plain herdr plugin uninstall reads as removed", () => {
    expect(ask(herdr(configDir, { out: list([{ plugin_id: "other", enabled: true }]) }))).toBe("removed");
  });

  test("herdr plugin disable reads as removed too", () => {
    expect(ask(herdr(configDir, { out: list([{ plugin_id: "shahi", enabled: false }]) }))).toBe("removed");
  });

  test("an answer about a different herdr configuration never removes anything", () => {
    // The service was installed from one config root and this herdr CLI reads
    // another (a different XDG_CONFIG_HOME): its empty registry proves nothing.
    expect(ask(herdr(configDir, { out: list([]) }, "/tmp/other/herdr/plugins/config/shahi"))).toBe("unknown");
  });

  test("no clear answer leaves a working install running", () => {
    expect(ask(herdr(configDir, { ok: false, out: "" }))).toBe("unknown");
    expect(ask(herdr(configDir, { out: "not json" }))).toBe("unknown");
    expect(ask(herdr(configDir, { out: JSON.stringify({ error: { code: "server_not_running" } }) }))).toBe("unknown");
    expect(ask(() => ({ ok: false, out: "" }))).toBe("unknown");
    expect(registration({ herdr: null, pluginId: "shahi", configDir, command: herdr(configDir, { out: list([]) }) })).toBe("unknown");
    // A manager outside the plugin (the smoke tests) has no config directory.
    expect(registration({ herdr: "/usr/local/bin/herdr", pluginId: "shahi", configDir: "", command: herdr("", { out: list([]) }) })).toBe("unknown");
  });

  test("one transient answer during a reinstall does not remove the service", async () => {
    const answers = ["removed", "enabled"] as const; let i = 0;
    expect(await confirmedRemoved(() => answers[i++]!, async () => {})).toBe(false);
    expect(await confirmedRemoved(() => "removed", async () => {})).toBe(true);
    expect(await confirmedRemoved(() => "unknown", async () => {})).toBe(false);
  });
});

describe("the service the plugin installs", () => {
  test("carries what the manager needs to ask the herdr that installed it", () => {
    const saved = { HERDR_PLUGIN_ID: process.env.HERDR_PLUGIN_ID, HERDR_BIN_PATH: process.env.HERDR_BIN_PATH, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
    try {
      Object.assign(process.env, { HERDR_PLUGIN_ID: "shahi-fork", HERDR_BIN_PATH: "/opt/herdr/bin/herdr", XDG_CONFIG_HOME: "/home/me/.xdg" });
      const layout = layoutFromEnv({
        HERDR_PLUGIN_ROOT: "/home/me/.xdg/herdr/plugins/github/shahi", HERDR_PLUGIN_CONFIG_DIR: "/home/me/.xdg/herdr/plugins/config/shahi-fork",
        HERDR_PLUGIN_STATE_DIR: "/home/me/.local/state/herdr/plugins/shahi-fork", HERDR_SOCKET_PATH: "/home/me/.xdg/herdr/herdr.sock",
      } as NodeJS.ProcessEnv);
      const { env } = serviceSpec(layout, new Map(), "/usr/local/bin/bun");
      expect(env.SHAHI_PLUGIN_ID).toBe("shahi-fork");
      expect(env.HERDR_BIN_PATH).toBe("/opt/herdr/bin/herdr");
      expect(env.XDG_CONFIG_HOME).toBe("/home/me/.xdg");
      // The directory the manager compares with `herdr plugin config-dir`.
      expect(dirname(env.SHAHI_ENV_FILE!)).toBe(layout.configDir);
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
});

describe("removing the service from inside it", () => {
  function recorder(file: string) {
    const calls: string[] = [];
    return { calls, exec: (argv: string[]) => { calls.push(`${argv.join(" ")} ${existsSync(file) ? "present" : "absent"}`); return { ok: argv[1] !== "print", out: "" }; } };
  }

  test("launchd: the plist is gone before bootout ends the process that asked", () => {
    const home = scratch(); const path = launchd(home, 501).path;
    mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, "plist");
    const r = recorder(path); launchd(home, 501, r.exec).remove();
    expect(r.calls[0]).toBe("launchctl bootout gui/501/app.shahi.sidecar absent");
    expect(existsSync(path)).toBe(false);
  });

  test("systemd: disabled and deleted before the stop that ends the process that asked", () => {
    const home = scratch(); const path = systemd(home).path;
    mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, "unit");
    const r = recorder(path); systemd(home, { exec: r.exec }).remove();
    expect(r.calls).toEqual([
      "systemctl --user disable shahi.service present",
      "systemctl --user daemon-reload absent",
      "systemctl --user stop shahi.service absent",
    ]);
  });
});

describe("the manager, after herdr no longer has the plugin", () => {
  // A manager that outlives its test would keep its fake service running.
  const managers: ReturnType<typeof Bun.spawn>[] = [];
  afterEach(async () => {
    for (const m of managers.splice(0)) if (m.exitCode === null) { m.kill("SIGTERM"); await Promise.race([m.exited, Bun.sleep(8_000)]); m.kill("SIGKILL"); }
  });
  const release: Release = { version: "0.3.0", buildId: "retire-test", commit: "a".repeat(40), artifact: { url: "https://github.com/iYassr/shahi/releases/download/v0.3.0/shahi-service.tar.gz", sha256: "0".repeat(64), bytes: 1 }, platforms: ["linux-x64"], bun: "1.3.13", api: { min: 5, max: 5 }, transport: 2, control: 1, manager: 1, dataSchema: 1, herdr: [{ version: "0.9.0", protocol: 22 }] };

  async function computer(plugins: object[]) {
    const dir = scratch();
    const home = join(dir, "home"), bin = join(dir, "bin"), configDir = join(dir, "config"), root = join(dir, "managed"), log = join(dir, "calls.log");
    const unit = process.platform === "darwin" ? launchd(home, process.getuid!()).path : systemd(home).path;
    for (const d of [bin, configDir, join(unit, "..")]) mkdirSync(d, { recursive: true });
    writeFileSync(unit, "installed by the plugin");
    writeFileSync(join(configDir, ".env"), "");
    const script = (body: string) => `#!/bin/sh\n${body}\n`;
    const fake = (name: string, body: string) => { writeFileSync(join(bin, name), script(body)); chmodSync(join(bin, name), 0o755); };
    const record = `if [ -e "${unit}" ]; then s=present; else s=absent; fi\nprintf '%s %s\\n' "$0 $*" "$s" >> "${log}"`;
    fake("launchctl", `${record}\n[ "$1" = print ] && exit 1\nexit 0`);
    fake("systemctl", `${record}\nexit 0`);
    fake("herdr", `case "$2" in\n  config-dir) printf '%s\\n' "${configDir}" ;;\n  list) printf '%s\\n' '${list(plugins)}' ;;\n  *) exit 2 ;;\nesac`);
    // A staged release whose "service" only says it was started.
    const releaseDir = join(root, "releases", release.buildId);
    mkdirSync(releaseDir, { recursive: true });
    writeFileSync(join(releaseDir, "verified.json"), JSON.stringify(release));
    writeFileSync(join(releaseDir, "service.js"), `require("node:fs").writeFileSync(${JSON.stringify(join(dir, "service-started"))}, "1"); setInterval(() => {}, 1000);`);
    atomicJson(join(root, "installation.json"), { active: release, channel: "stable", sequence: {} });
    const manager = Bun.spawn([process.execPath, join(import.meta.dir, "manager.ts")], {
      cwd: dir, stdout: "pipe", stderr: "pipe",
      env: {
        HOME: home, PATH: bin, SHAHI_MANAGER_ROOT: root, SHAHI_ENV_FILE: join(configDir, ".env"), SHAHI_PLUGIN_ID: "shahi",
        HERDR_BIN_PATH: join(bin, "herdr"), HERDR_SOCKET_PATH: join(dir, "no-herdr.sock"), SHAHI_DATA: join(dir, "shahi.sqlite"),
        SESSION_SECRET: crypto.randomUUID(), PASSCODE_HASH_B64: Buffer.from(await Auth.hashPasscode("2468")).toString("base64"),
        PORT: "1", RELAY_URL: "",
      },
    });
    managers.push(manager);
    const calls = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(l => l.replace(`${bin}/`, "")) : [];
    return { dir, unit, manager, calls };
  }

  test("it removes its own service instead of starting Shahi", async () => {
    const c = await computer([{ plugin_id: "other", enabled: true }]);
    expect(await Promise.race([c.manager.exited, Bun.sleep(20_000).then(() => "still running")])).toBe(0);
    expect(existsSync(join(c.dir, "service-started"))).toBe(false);
    expect(existsSync(c.unit)).toBe(false);
    const stops = c.calls().filter(l => l.includes(" bootout ") || l.includes(" stop "));
    expect(stops.length).toBe(1);
    expect(stops[0]!.endsWith(" absent")).toBe(true);
  }, 30_000);

  test("while the plugin is enabled it starts Shahi and removes nothing", async () => {
    const c = await computer([{ plugin_id: "shahi", enabled: true }]);
    const until = Date.now() + 15_000;
    while (!existsSync(join(c.dir, "service-started")) && c.manager.exitCode === null && Date.now() < until) await Bun.sleep(100);
    c.manager.kill("SIGTERM"); await c.manager.exited;
    expect(existsSync(join(c.dir, "service-started"))).toBe(true);
    expect(existsSync(c.unit)).toBe(true);
    expect(c.calls()).toEqual([]);
  }, 30_000);
});
