import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layoutFromEnv } from "./layout";
import { LAUNCHD_LABEL, renderLaunchd, renderSystemd, serviceFor, type ServiceSpec } from "./service";
import { serviceSpec } from "./shahi";

const layout = layoutFromEnv({
  HERDR_PLUGIN_ROOT: "/Users/me/herdr/plugins/github/shahi",
  HERDR_PLUGIN_CONFIG_DIR: "/Users/me/Library/Application Support/herdr/plugins/shahi",
  HERDR_PLUGIN_STATE_DIR: "/Users/me/.local/state/herdr/plugins/shahi",
  HERDR_SOCKET_PATH: "/Users/me/.config/herdr/sessions/work/herdr.sock",
} as NodeJS.ProcessEnv);

const spec: ServiceSpec = serviceSpec(layout, new Map([["PORT", "7275"]]), "/opt/homebrew/bin/bun");

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
  test("picks launchd on macOS and systemd on Linux, under the given home", () => {
    expect(serviceFor("darwin", "/Users/me", 501).path).toBe(`/Users/me/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`);
    expect(serviceFor("linux", "/home/me", 1000).path).toBe("/home/me/.config/systemd/user/shahi.service");
    expect(() => serviceFor("win32", "C:/", 0)).toThrow(/launchd or systemd/);
  });
});
