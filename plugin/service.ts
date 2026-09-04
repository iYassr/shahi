/**
 * The user service that supervises the sidecar: launchd on macOS, systemd on
 * Linux. Rendering is pure and tested; the handful of `launchctl` and
 * `systemctl` calls are the only side effects, and each one is the same
 * command a person would type.
 *
 * Herdr's startup hooks are one-shot by contract — "not supervised daemons" —
 * so the sidecar cannot simply be the hook. The hook installs this instead,
 * and the OS keeps the sidecar alive through herdr restarts, crashes and
 * reboots, which is the whole point of a phone dashboard.
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const LAUNCHD_LABEL = "app.shahi.sidecar";
export const SYSTEMD_UNIT = "shahi.service";

export interface ServiceSpec {
  /** Absolute path to bun — the one running the hook, so the service gets the same. */
  bun: string;
  /** The plugin root: working directory, and where `server/index.ts` is. */
  root: string;
  env: Record<string, string>;
  logPath: string;
}

export interface ServiceStatus {
  /** The unit or plist file exists. */
  installed: boolean;
  running: boolean;
  pid: number | null;
}

export interface Service {
  kind: "launchd" | "systemd";
  /** The plist or unit file. */
  path: string;
  /** How to follow the service's own view, for the docs and `status`. */
  inspect: string;
  render(spec: ServiceSpec): string;
  /**
   * Writes the file and (re)starts the service from it. Always a restart:
   * `enable --now` does nothing to a running service, so an in-place upgrade
   * once kept the old code running while looking applied.
   */
  install(spec: ServiceSpec): void;
  stop(): void;
  status(): ServiceStatus;
  /** Stops it and removes the file. */
  remove(): void;
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderLaunchd(spec: ServiceSpec, label = LAUNCHD_LABEL): string {
  const env = Object.entries(spec.env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join("\n");
  // KeepAlive without conditions: the sidecar exits when herdr's socket is
  // gone, and launchd bringing it back every few seconds is what makes it
  // reappear on its own once herdr does. ThrottleInterval keeps that loop
  // polite. Stopping for real is `bootout`, which removes the job entirely.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(spec.bun)}</string>
    <string>run</string>
    <string>server/index.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(spec.root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>3</integer>
  <key>StandardOutPath</key>
  <string>${xml(spec.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(spec.logPath)}</string>
</dict>
</plist>
`;
}

function unitQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function renderSystemd(spec: ServiceSpec): string {
  const env = Object.entries(spec.env)
    .map(([k, v]) => `Environment=${unitQuote(`${k}=${v}`)}`)
    .join("\n");
  return `# Shahi — installed by the herdr plugin's startup hook. Edits here are
# overwritten on the next herdr start; change the plugin's .env instead.
[Unit]
Description=Shahi — a phone-shaped window onto herdr
After=default.target
# Never give up like launchd's KeepAlive does: systemd's default start-rate
# limiter (5 starts / 10s) would wedge the sidecar off after a fast crash-loop
# — precisely when a phone wants it back — and leave it dead until a manual
# reset. RestartSec=3 already paces the retries (pre-release review).
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=${spec.root}
${env}
ExecStart=${spec.bun} run server/index.ts
StandardOutput=append:${spec.logPath}
StandardError=append:${spec.logPath}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;
}

function run(argv: string[]): { ok: boolean; out: string } {
  try {
    const proc = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
    return { ok: proc.exitCode === 0, out: proc.stdout.toString() + proc.stderr.toString() };
  } catch (err) {
    // A missing binary throws rather than failing; report it the same way.
    return { ok: false, out: err instanceof Error ? err.message : String(err) };
  }
}

function must(argv: string[]): void {
  const { ok, out } = run(argv);
  if (!ok) throw new Error(`${argv.join(" ")} failed:\n${out.trim()}`);
}

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

export function launchd(home: string, uid: number): Service {
  const path = join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  const target = `gui/${uid}/${LAUNCHD_LABEL}`;
  const bootout = () => {
    run(["launchctl", "bootout", target]);
    // bootout returns before the job is gone; a bootstrap that races it fails
    // with "service already loaded". Wait for launchd to actually forget it.
    const until = Date.now() + 5_000;
    while (run(["launchctl", "print", target]).ok && Date.now() < until) Bun.sleepSync(100);
  };
  return {
    kind: "launchd",
    path,
    inspect: `launchctl print ${target}`,
    render: (spec) => renderLaunchd(spec),
    install(spec) {
      write(path, renderLaunchd(spec));
      bootout();
      must(["launchctl", "bootstrap", `gui/${uid}`, path]);
    },
    stop: bootout,
    status() {
      const installed = existsSync(path);
      const { ok, out } = run(["launchctl", "print", target]);
      const pid = out.match(/^\s*pid = (\d+)/m)?.[1];
      return { installed, running: ok && /^\s*state = running/m.test(out), pid: pid ? Number(pid) : null };
    },
    remove() {
      bootout();
      if (existsSync(path)) unlinkSync(path);
    },
  };
}

export function systemd(home: string): Service {
  const path = join(home, ".config", "systemd", "user", SYSTEMD_UNIT);
  return {
    kind: "systemd",
    path,
    inspect: `systemctl --user status ${SYSTEMD_UNIT}`,
    render: renderSystemd,
    install(spec) {
      write(path, renderSystemd(spec));
      must(["systemctl", "--user", "daemon-reload"]);
      run(["systemctl", "--user", "enable", SYSTEMD_UNIT]);
      must(["systemctl", "--user", "restart", SYSTEMD_UNIT]);
    },
    stop() {
      run(["systemctl", "--user", "stop", SYSTEMD_UNIT]);
    },
    status() {
      const installed = existsSync(path);
      const active = run(["systemctl", "--user", "is-active", SYSTEMD_UNIT]).out.trim() === "active";
      const pid = Number(run(["systemctl", "--user", "show", "-p", "MainPID", "--value", SYSTEMD_UNIT]).out.trim());
      return { installed, running: active, pid: pid > 0 ? pid : null };
    },
    remove() {
      run(["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT]);
      if (existsSync(path)) unlinkSync(path);
      run(["systemctl", "--user", "daemon-reload"]);
    },
  };
}

export function serviceFor(
  platform: NodeJS.Platform,
  home: string,
  uid: number,
  /** Injected so the Linux branch is testable from a Mac, which has no systemctl. */
  hasSystemctl: () => boolean = () => Bun.which("systemctl") !== null,
): Service {
  if (platform === "darwin") return launchd(home, uid);
  if (platform === "linux") {
    // Linux does not imply systemd. Alpine ships busybox init with OpenRC and
    // does not package systemd at all — `apk search -x systemd` returns
    // nothing — so there is no version of this that works there (measured on
    // Alpine 3.23, 2026-09-04). Assuming it wrote a unit file nothing could
    // load and then failed with `Executable not found in $PATH: "systemctl"`,
    // which tells the reader neither what went wrong nor what to do.
    //
    // Checking first also means no half-installed unit is left behind: this
    // throws before `install` writes anything.
    //
    // Worth saying plainly in the message, because it was measured on that
    // same box: everything except supervision works there. The sidecar runs on
    // musl, attaches to herdr, serves /api/meta and reaches the relay. Only
    // the thing that keeps it running is missing.
    if (!hasSystemctl()) {
      throw new Error(
        "No systemd on this machine, so there is no user service to install.\n" +
          "Alpine and other busybox/OpenRC systems do not have one, and cannot install it.\n" +
          "\n" +
          "Shahi itself works here — the sidecar runs, reaches herdr and dials the relay.\n" +
          "What is missing is supervision, so start it yourself and let this box's own\n" +
          "init keep it alive (`herdr plugin action invoke shahi.status` prints the paths):\n" +
          "\n" +
          "  cd \"$HERDR_PLUGIN_ROOT\" && bun run server/index.ts",
      );
    }
    return systemd(home);
  }
  throw new Error(`Shahi's herdr plugin supervises the sidecar with launchd or systemd; ${platform} has neither.`);
}
