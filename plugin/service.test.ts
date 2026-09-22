import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layoutFromEnv } from "./layout";
import { LAUNCHD_LABEL, renderCommand, renderLaunchd, renderSystemd, serviceFor, systemd, userBusHelp, type ServiceSpec } from "./service";
import { serviceSpec } from "./shahi";

const layout = layoutFromEnv({
  HERDR_PLUGIN_ROOT: "/Users/me/herdr/plugins/github/shahi",
  HERDR_PLUGIN_CONFIG_DIR: "/Users/me/Library/Application Support/herdr/plugins/shahi",
  HERDR_PLUGIN_STATE_DIR: "/Users/me/.local/state/herdr/plugins/shahi",
  HERDR_SOCKET_PATH: "/Users/me/.config/herdr/sessions/work/herdr.sock",
} as NodeJS.ProcessEnv);

const spec: ServiceSpec = serviceSpec(layout, new Map([["PORT", "7275"]]), "/opt/homebrew/bin/bun");
/** What `install` in shahi.ts hands a service: the approved manager, not the checkout. */
const managedSpec: ServiceSpec = {
  ...spec,
  root: "/Users/me/.local/state/herdr/plugins/shahi/managed",
  entry: "/Users/me/.local/state/herdr/plugins/shahi/managed/manager.js",
  env: { ...spec.env, SHAHI_MANAGER_ROOT: "/Users/me/.local/state/herdr/plugins/shahi/managed" },
};

describe("serviceSpec", () => {
  test("names every path the sidecar needs, under the directories herdr gave", () => {
    expect(spec.root).toBe(layout.root);
    expect(spec.env.HERDR_SOCKET_PATH).toBe("/Users/me/.config/herdr/sessions/work/herdr.sock");
    expect(spec.env.SHAHI_ENV_FILE).toBe("/Users/me/Library/Application Support/herdr/plugins/shahi/.env");
    expect(spec.env.SHAHI_DATA).toBe("/Users/me/.local/state/herdr/plugins/shahi/shahi.sqlite");
    expect(spec.env.WEB_ROOT).toBe("/Users/me/herdr/plugins/github/shahi/web/dist");
    expect(spec.logPath).toBe("/Users/me/.local/state/herdr/plugins/shahi/shahi.log");
  });

  test("takes PORT from the .env and defaults to 7171", () => {
    expect(spec.env.PORT).toBe("7275");
    expect(serviceSpec(layout, new Map()).env.PORT).toBe("7171");
  });

  test("puts bun's own directory first on PATH", () => {
    // A bun from bun.sh's fallback list is, by definition, not on herdr's PATH.
    expect(spec.env.PATH!.split(":")[0]).toBe("/opt/homebrew/bin");
  });
});

describe("renderLaunchd", () => {
  const plist = renderLaunchd(spec);

  test("runs bun from the plugin root, logs to the state dir, and stays alive", () => {
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toContain("<string>/opt/homebrew/bin/bun</string>\n    <string>run</string>\n    <string>server/index.ts</string>");
    expect(plist).toContain(`<key>WorkingDirectory</key>\n  <string>${layout.root}</string>`);
    expect(plist).toContain(`<key>StandardErrorPath</key>\n  <string>${layout.logPath}</string>`);
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
  });

  test("carries every environment variable", () => {
    for (const [k, v] of Object.entries(spec.env)) {
      expect(plist).toContain(`<key>${k}</key>\n    <string>${v.replace(/&/g, "&amp;")}</string>`);
    }
  });

  test("escapes XML in paths", () => {
    // A path with `&` is legal on disk and fatal in an unescaped plist —
    // launchd rejects the file and the service silently never loads.
    const odd = renderLaunchd({ ...spec, root: "/Users/me/a&b<c>" });
    expect(odd).toContain("<string>/Users/me/a&amp;b&lt;c&gt;</string>");
    expect(odd).not.toContain("a&b");
  });

  test("is a plist macOS accepts", () => {
    if (process.platform !== "darwin") return;
    const path = join(mkdtempSync(join(tmpdir(), "shahi-plist-")), "x.plist");
    writeFileSync(path, renderLaunchd({ ...spec, root: "/Users/me/a&b" }));
    expect(Bun.spawnSync(["plutil", "-lint", path], { stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
  });
});

describe("renderSystemd", () => {
  test("never gives up on a crash-loop the way launchd does not", () => {
    const unit = renderSystemd(spec);
    expect(unit).toContain("StartLimitIntervalSec=0");
    expect(unit).toContain("Restart=always");
  });

  const unit = renderSystemd(spec);

  test("runs bun from the plugin root, logs to the state dir, restarts", () => {
    expect(unit).toContain(`WorkingDirectory=${layout.root}`);
    expect(unit).toContain("ExecStart=/opt/homebrew/bin/bun run server/index.ts");
    expect(unit).toContain(`StandardOutput=append:${layout.logPath}`);
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=default.target");
  });

  test("quotes every environment assignment, so a space in a path survives", () => {
    // The config dir on macOS-style layouts has a space in it; systemd splits
    // an unquoted Environment= on whitespace.
    expect(unit).toContain(
      'Environment="SHAHI_ENV_FILE=/Users/me/Library/Application Support/herdr/plugins/shahi/.env"',
    );
    for (const k of Object.keys(spec.env)) expect(unit).toContain(`Environment="${k}=`);
  });

  test("escapes a double quote inside a value", () => {
    const odd = renderSystemd({ ...spec, env: { X: 'say "hi"' } });
    expect(odd).toContain('Environment="X=say \\"hi\\""');
  });
});

describe("serviceFor", () => {
  const withSystemd = () => true;

  test("picks launchd on macOS and systemd on Linux, under the given home", () => {
    expect(serviceFor("darwin", "/Users/me", 501).path).toBe(`/Users/me/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`);
    expect(serviceFor("linux", "/home/me", 1000, withSystemd).path).toBe("/home/me/.config/systemd/user/shahi.service");
    expect(() => serviceFor("win32", "C:/", 0)).toThrow(/launchd or systemd/);
  });

  // Measured on Alpine 3.23 (2026-09-04): busybox init, OpenRC, and no systemd
  // in the repositories at all. The old code assumed Linux meant systemd, wrote
  // a unit file nothing could load, and failed with `Executable not found in
  // $PATH: "systemctl"`.
  test("a Linux without systemd installs nothing, and says what does work", () => {
    const home = mkdtempSync(join(tmpdir(), "shahi-nosystemd-"));
    const service = serviceFor("linux", home, 1000, () => false);
    expect(service.kind).toBe("none");
    expect(() => service.install(managedSpec)).toThrow(/No systemd on this machine/);
    // The message has to be actionable: name the cause, and the fact that only
    // supervision is missing — the sidecar itself runs fine there.
    expect(() => service.install(managedSpec)).toThrow(/OpenRC/);
    expect(existsSync(join(home, ".config"))).toBe(false);
    expect(service.status()).toEqual({ installed: false, running: false, pid: null });
  });
});

/**
 * The pre-release review followed the Alpine message and hit a dead end: every
 * verb, `status` included, threw before a secret existed, and the command it
 * offered (`cd "$HERDR_PLUGIN_ROOT" && bun run server/index.ts`) named no .env,
 * so it died on "SESSION_SECRET is not set" — in a shell where that variable
 * is not even set — and could not have paired a phone without the relay.
 */
describe("the Alpine hand-over command", () => {
  test("is the process the unit would run, with every variable, and it starts as printed", () => {
    const dir = mkdtempSync(join(tmpdir(), "shahi odd 'dir' "));
    const record = join(dir, "record.txt");
    // A stand-in for bun that writes down what it was started with.
    const bun = join(dir, "fake bun");
    writeFileSync(bun, `#!/bin/sh\n{ pwd; printf '%s\\n' "$@"; env; } > '${record.replace(/'/g, `'\\''`)}'\n`);
    chmodSync(bun, 0o755);
    const spec = { ...managedSpec, bun, root: dir, logPath: join(dir, "shahi.log") };

    let said = "";
    try { serviceFor("linux", dir, 1000, () => false).install(spec); } catch (err) { said = (err as Error).message; }
    const command = said.split("\n").find((line) => line.trimStart().startsWith("cd "))!.trim();
    expect(command).toBe(renderCommand(spec));

    expect(Bun.spawnSync(["/bin/sh", "-c", command], { env: { PATH: "/usr/bin:/bin" } }).exitCode).toBe(0);
    const [cwd, run, entry, ...env] = readFileSync(record, "utf8").split("\n");
    expect(realpathSync(cwd!)).toBe(realpathSync(dir));
    expect([run, entry]).toEqual(["run", managedSpec.entry]);
    for (const key of ["SHAHI_ENV_FILE", "SHAHI_DATA", "RELAY_URL", "HERDR_SOCKET_PATH", "SHAHI_MANAGER_ROOT", "PORT"]) {
      expect(env).toContain(`${key}=${spec.env[key]}`);
    }
  });
});

/**
 * Found in the pre-release review by running setup from `su` and `sudo -iu`
 * shells: systemctl's own "Failed to connect to user scope bus" was all a
 * person saw, and the lingering hint that answers it prints only after a
 * successful install.
 */
describe("a systemd with no user bus", () => {
  test("says how to get one, instead of systemctl's words alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "shahi-nobus-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "systemctl"),
      "#!/bin/sh\necho 'Failed to connect to user scope bus via local transport: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined' >&2\nexit 1\n",
    );
    chmodSync(join(bin, "systemctl"), 0o755);
    const before = process.env.PATH;
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    try {
      expect(() => systemd(dir, 1000, "op").install(spec)).toThrow(/sudo loginctl enable-linger op/);
      expect(() => systemd(dir, 1000, "op").install(spec)).toThrow(/XDG_RUNTIME_DIR=\/run\/user\/1000/);
      expect(() => systemd(dir, 1000, "op").install(spec)).toThrow(/herdr plugin action invoke shahi\.restart/);
    } finally {
      process.env.PATH = before;
    }
  });

  test("any other systemctl failure is reported as it was", () => {
    expect(userBusHelp("Unit shahi.service has a bad setting.", "op", 1000)).toBeNull();
  });
});
