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
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { herdrCli } from "../server/lib/herdr-session";

export const LAUNCHD_LABEL = "app.shahi.sidecar";
export const SYSTEMD_UNIT = "shahi.service";

export interface ServiceSpec {
  /** Absolute path to bun — the one running the hook, so the service gets the same. */
  bun: string;
  /** The plugin root: working directory, and where `server/index.ts` is. */
  root: string;
  entry?: string;
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
  /** `none`: a Linux without systemd, where the person supervises the sidecar (see `unsupervised`). */
  kind: "launchd" | "systemd" | "none";
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
    <string>${xml(spec.entry ?? "server/index.ts")}</string>
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The same process a unit would start, as one line of POSIX shell: working
 * directory, every environment variable, the log. For a machine with no
 * service manager this is the whole hand-over, so it has to run as printed.
 */
export function renderCommand(spec: ServiceSpec): string {
  const env = Object.entries(spec.env).map(([k, v]) => `${k}=${shellQuote(v)}`).join(" ");
  return `cd ${shellQuote(spec.root)} && exec env ${env} ${shellQuote(spec.bun)} run ${shellQuote(spec.entry ?? "server/index.ts")} >> ${shellQuote(spec.logPath)} 2>&1`;
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
ExecStart=${spec.bun} run ${spec.entry ? unitQuote(spec.entry) : "server/index.ts"}
StandardOutput=append:${spec.logPath}
StandardError=append:${spec.logPath}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;
}

type Run = (argv: string[]) => { ok: boolean; out: string };

function run(argv: string[]): { ok: boolean; out: string } {
  try {
    // `env: process.env` explicitly: without it Bun 1.4 looks the bare name up
    // on the PATH the process started with, ignoring main()'s removal of
    // node_modules/.bin (pentest M4) — measured in the pre-release review.
    const proc = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", env: process.env });
    return { ok: proc.exitCode === 0, out: proc.stdout.toString() + proc.stderr.toString() };
  } catch (err) {
    // A missing binary throws rather than failing; report it the same way.
    return { ok: false, out: err instanceof Error ? err.message : String(err) };
  }
}

function must(argv: string[], exec: Run = run): void {
  const { ok, out } = exec(argv);
  if (!ok) throw new Error(`${argv.join(" ")} failed:\n${out.trim()}`);
}

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

/*
 * `remove()` takes the file away before it stops anything, on both systems.
 * The manager removes its own service when herdr no longer has the plugin
 * (releases/registration.ts), and stopping the service ends that very
 * process, so nothing after the stop is guaranteed to run. A file left behind
 * would start Shahi again at the next login (pre-public-release review).
 * `exec` is injectable so that order is tested without touching a real
 * service.
 */
const launchdPath = (home: string) => join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
const systemdPath = (home: string) => join(home, ".config", "systemd", "user", SYSTEMD_UNIT);

export function launchd(home: string, uid: number, exec: Run = run): Service {
  const path = launchdPath(home);
  const target = `gui/${uid}/${LAUNCHD_LABEL}`;
  const bootout = () => {
    exec(["launchctl", "bootout", target]);
    // bootout returns before the job is gone; a bootstrap that races it fails
    // with "service already loaded". Wait for launchd to actually forget it.
    const until = Date.now() + 5_000;
    while (exec(["launchctl", "print", target]).ok && Date.now() < until) Bun.sleepSync(100);
  };
  return {
    kind: "launchd",
    path,
    inspect: `launchctl print ${target}`,
    render: (spec) => renderLaunchd(spec),
    install(spec) {
      write(path, renderLaunchd(spec));
      bootout();
      must(["launchctl", "bootstrap", `gui/${uid}`, path], exec);
    },
    stop: bootout,
    status() {
      const installed = existsSync(path);
      const { ok, out } = exec(["launchctl", "print", target]);
      const pid = out.match(/^\s*pid = (\d+)/m)?.[1];
      return { installed, running: ok && /^\s*state = running/m.test(out), pid: pid ? Number(pid) : null };
    },
    remove() {
      // bootout names the job by label, so it needs no file.
      if (existsSync(path)) unlinkSync(path);
      bootout();
    },
  };
}

/**
 * What to do when `systemctl --user` has no user manager to talk to. Found
 * by running setup from `su` and `sudo -iu` shells in the pre-release review:
 * systemd's own words — "Failed to connect to user scope bus", "$DBUS_SESSION_BUS_ADDRESS
 * and $XDG_RUNTIME_DIR not defined" — were all a person got, and the
 * lingering hint that would have helped is printed only after a successful
 * install, so it never appeared.
 */
export function userBusHelp(out: string, user: string, uid: number): string | null {
  if (!/Failed to connect to (user scope )?bus|XDG_RUNTIME_DIR/.test(out)) return null;
  return [
    `systemctl --user could not reach ${user}'s systemd: ${out.trim().split("\n").at(-1)}`,
    "That happens in a shell without a login session of its own (su, sudo -iu, some containers).",
    `Start herdr from a real login as ${user} (SSH or a console), or keep ${user}'s systemd running with, once:`,
    `  sudo loginctl enable-linger ${user}`,
    `If this shell has no XDG_RUNTIME_DIR, start herdr with:  export XDG_RUNTIME_DIR=/run/user/${uid}`,
    `Then:  ${herdrCli(process.env.HERDR_SOCKET_PATH)} plugin action invoke shahi.restart`,
  ].join("\n");
}

export function systemd(
  home: string,
  { uid = process.getuid?.() ?? 0, user = userInfo().username, exec = run }: { uid?: number; user?: string; exec?: Run } = {},
): Service {
  const path = systemdPath(home);
  const systemctl =(argv: string[]) => {
    const { ok, out } = exec(["systemctl", "--user", ...argv]);
    if (!ok) throw new Error(userBusHelp(out, user, uid) ?? `systemctl --user ${argv.join(" ")} failed:\n${out.trim()}`);
  };
  return {
    kind: "systemd",
    path,
    inspect: `systemctl --user status ${SYSTEMD_UNIT}`,
    render: renderSystemd,
    install(spec) {
      write(path, renderSystemd(spec));
      systemctl(["daemon-reload"]);
      exec(["systemctl", "--user", "enable", SYSTEMD_UNIT]);
      systemctl(["restart", SYSTEMD_UNIT]);
    },
    stop() {
      exec(["systemctl", "--user", "stop", SYSTEMD_UNIT]);
    },
    status() {
      const installed = existsSync(path);
      const active = exec(["systemctl", "--user", "is-active", SYSTEMD_UNIT]).out.trim() === "active";
      const pid = Number(exec(["systemctl", "--user", "show", "-p", "MainPID", "--value", SYSTEMD_UNIT]).out.trim());
      return { installed, running: active, pid: pid > 0 ? pid : null };
    },
    remove() {
      // `disable` reads the unit file to find its links, so it runs while the
      // file exists; a loaded, running unit can still be stopped without it.
      exec(["systemctl", "--user", "disable", SYSTEMD_UNIT]);
      if (existsSync(path)) unlinkSync(path);
      exec(["systemctl", "--user", "daemon-reload"]);
      exec(["systemctl", "--user", "stop", SYSTEMD_UNIT]);
    },
  };
}

/**
 * A Linux without systemd. Alpine ships busybox init with OpenRC and does not
 * package systemd at all — `apk search -x systemd` returns nothing — so there
 * is no user service to install there (measured on Alpine 3.23, 2026-09-04),
 * and OpenRC has no per-user services to port the unit to.
 *
 * Everything except supervision works there: the sidecar runs on musl,
 * attaches to herdr, serves /api/meta and reaches the relay. So every step of
 * setup still happens — the secrets, the approved release — and `install`,
 * which writes nothing, hands over the exact process a unit would have
 * started. Refusing earlier was a dead end (pre-release review): every verb,
 * `status` included, threw before a secret existed, and the command it
 * suggested named neither the .env nor the relay, so it could not start.
 */
export function unsupervised(): Service {
  return {
    kind: "none",
    path: "no service manager on this machine (no systemd)",
    inspect: "ps -ef | grep '[m]anager.js'",
    render: renderCommand,
    install(spec) {
      throw new Error(
        "Shahi is not running. No systemd on this machine, so there is no user service to install.\n" +
          "Alpine and other busybox/OpenRC systems do not have one, and cannot install it.\n" +
          "\n" +
          "Everything else is ready: the secrets and the approved release this runs.\n" +
          "Start it yourself, and have this box's own init keep it running — restart it\n" +
          "whenever it exits, because an update exits it on purpose:\n" +
          "\n" +
          `  ${renderCommand(spec)}\n` +
          "\n" +
          `Once it answers, pair a phone:  ${herdrCli(spec.env.HERDR_SOCKET_PATH)} plugin action invoke shahi.pair`,
      );
    },
    stop() {
      throw new Error("No service here to stop: stop the sidecar wherever you started it.");
    },
    status: () => ({ installed: false, running: false, pid: null }),
    remove() {},
  };
}

const unxml = (value: string) =>
  value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

/** The EnvironmentVariables a plist rendered by `renderLaunchd` carries. */
export function launchdEnvironment(plist: string): Record<string, string> {
  const dict = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(plist)?.[1] ?? "";
  return Object.fromEntries([...dict.matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)].map(([, k, v]) => [unxml(k!), unxml(v!)]));
}

/** The Environment= lines a unit rendered by `renderSystemd` carries. */
export function systemdEnvironment(unit: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [, raw] of unit.matchAll(/^Environment=(.*)$/gm)) {
    const pair = /^"(.*)"$/.test(raw!) ? raw!.slice(1, -1).replace(/\\(["\\])/g, "$1") : raw!;
    const eq = pair.indexOf("=");
    if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return env;
}

/**
 * The environment the installed service was last rendered with — above all
 * its HERDR_SOCKET_PATH, the herdr it follows — read back from its plist or
 * unit; null when none is installed. For whoever has to reach that herdr
 * without being run by it: `herdr plugin install` strips HERDR_SOCKET_PATH
 * and HERDR_BIN_PATH from build commands (herdr 0.9.1), so plugin/update.ts
 * has no other way to know which session to restart Shahi through. Every
 * plugin version has rendered both files the same way, pre-managed 0.2.0
 * units included.
 */
export function installedEnvironment(platform: NodeJS.Platform, home: string): Record<string, string> | null {
  const path = platform === "darwin" ? launchdPath(home) : platform === "linux" ? systemdPath(home) : null;
  if (!path || !existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  return platform === "darwin" ? launchdEnvironment(text) : systemdEnvironment(text);
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
    // Linux does not imply systemd. Assuming it wrote a unit file nothing
    // could load and then failed with `Executable not found in $PATH:
    // "systemctl"`, which tells the reader neither what went wrong nor what to do.
    return hasSystemctl() ? systemd(home, { uid }) : unsupervised();
  }
  throw new Error(`Shahi's herdr plugin supervises the sidecar with launchd or systemd; ${platform} has neither.`);
}
