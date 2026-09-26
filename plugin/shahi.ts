import { bootstrap } from "./releases/bootstrap";
import { readJson, requestUpdate } from "./releases/storage";
/**
 * Everything the herdr plugin does, as one command with a verb:
 *
 *   sh plugin/bun.sh run plugin/shahi.ts setup       startup hook: secrets, service, go
 *   sh plugin/bun.sh run plugin/shahi.ts status      service, address, /api/meta, devices
 *   sh plugin/bun.sh run plugin/shahi.ts restart     re-render the service and restart it
 *   sh plugin/bun.sh run plugin/shahi.ts stop        until the next herdr start or restart
 *   sh plugin/bun.sh run plugin/shahi.ts logs        the tail of the sidecar's log
 *   sh plugin/bun.sh run plugin/shahi.ts pair        the QR, then wait for Enter (the popup)
 *   sh plugin/bun.sh run plugin/shahi.ts open-pair   open that popup (the action)
 *   sh plugin/bun.sh run plugin/shahi.ts reset-passcode   a new passcode, printed once, and a restart
 *   sh plugin/bun.sh run plugin/shahi.ts uninstall   the service, then the plugin; the data stays
 *
 * Every verb needs the environment herdr injects (HERDR_PLUGIN_ROOT and
 * friends), so the way to run one by hand is `herdr plugin action invoke
 * shahi.<verb>`, and the output lands in `herdr plugin log list --plugin shahi`.
 *
 * `setup` and `restart` are the same operation. The startup hook runs on
 * every herdr start, including the one after `herdr plugin install` replaced
 * the checkout, and a sidecar that kept running old code from a directory
 * that no longer exists would look updated and not be — so the service is
 * always re-rendered and always restarted, and the only difference is that
 * a first run has a passcode to show.
 *
 * The service is also pointed at Shahi's relay unless the `.env` says
 * otherwise. Before it was, a fresh install ended at "no address to give a
 * phone yet": the sidecar listens on loopback, and reaching it meant
 * Tailscale or SSH before the first QR could be scanned. With `RELAY_URL` the
 * box dials out, the pairing code carries the relay's address, and the phone
 * connects from anywhere (docs/relay.md). The default lives here, in code,
 * not in the user's file: written to disk it would be every install's trust
 * anchor for life, and the relay could never move without every user editing
 * a dotfile. A `RELAY_URL` key in the `.env` — empty for direct-only, or a
 * Worker of one's own — always wins.
 *
 * What the hook has to say goes to a herdr notification as well as the
 * plugin log — when `[ui.toast] delivery` is on, which it is not by default,
 * so the log stays the record and the popup is where a person actually
 * reads it: `pair` runs the setup itself when the service is missing, so
 * "install, then pair" is the whole flow and its output is on screen — held
 * there until Enter, success or failure, because herdr closes a popup the
 * moment its command exits. The passcode digits stay out of the toast: a
 * toast is also every attached client, a screen share, and on some terminals
 * the OS notification centre.
 */
import { existsSync, mkdirSync, openSync, readSync, closeSync, fstatSync, statSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { SHAHI_API_VERSION, type ComputerUpdate, type DeviceList, type ServerInfo } from "@shahi/shared";
import { Auth } from "../server/lib/auth";
import { parsePort } from "../server/lib/config";
import { herdrCli } from "../server/lib/herdr-session";
import { ensureSecrets, randomPasscode, readEnvFile, writeEnvFile } from "../server/lib/secrets";
import { layoutFromEnv, type Layout } from "./layout";
import { renderCommand, serviceFor, type Service, type ServiceSpec } from "./service";

export const VERBS = ["setup", "status", "restart", "stop", "logs", "pair", "open-pair", "reset-passcode", "uninstall"] as const;
type Verb = (typeof VERBS)[number];

/**
 * `herdr` for every command this prints: `herdr --session <name>` when the
 * herdr that runs this plugin is a named session, since a bare `herdr` typed
 * outside that session's panes reaches another one (server/lib/herdr-session.ts).
 */
export const herdr = () => herdrCli(process.env.HERDR_SOCKET_PATH);

/** herdr 0.8.2 has no menu for plugin actions: the CLI, or a key the person binds. */
const pairHint = () => `Pair a phone or browser:  ${herdr()} plugin action invoke shahi.pair`;
const KEY_HINT = 'or bind a key in herdr\'s config.toml:  [[keys.command]] key = "prefix+P", type = "plugin_action", command = "shahi.pair"';

/** Shahi's relay: a blind pipe (docs/relay.md). The plugin's default; any Worker deployed from `relay/` works the same. */
export const DEFAULT_RELAY_URL = "https://relay.getshahi.dev";

/**
 * The relay the service dials: what the `.env` says if it says anything —
 * a URL, or empty for direct-only — and Shahi's relay when the key is absent.
 */
export function relayUrlFor(env: Map<string, string>): string | null {
  if (!env.has("RELAY_URL")) return DEFAULT_RELAY_URL;
  return env.get("RELAY_URL") || null;
}

/** A line in herdr's tray, for what would otherwise only reach the plugin log. Best effort. */
function notify(title: string, body: string): void {
  const bin = process.env.HERDR_BIN_PATH ?? "herdr";
  try {
    Bun.spawnSync([bin, "notification", "show", title, "--body", body, "--sound", "none"], {
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    // No herdr on PATH and no HERDR_BIN_PATH: the plugin log still has it.
  }
}

/**
 * On Linux a user service stops with the user's last session unless lingering
 * is on — precisely when a phone would want it. The plugin cannot enable it
 * (it needs sudo on some distributions), so it says so once, with the command.
 */
export function lingerHint(platform: NodeJS.Platform, lingerValue: string | null, user: string): string | null {
  if (platform !== "linux" || lingerValue === null || lingerValue.trim() !== "no") return null;
  return `This is a user service and lingering is off: it stops when your last session ends. Once:  loginctl enable-linger ${user}`;
}

function lingerValue(): string | null {
  try {
    const proc = Bun.spawnSync(["loginctl", "show-user", process.env.USER ?? userInfo().username, "-p", "Linger", "--value"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    return proc.exitCode === 0 ? proc.stdout.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The bun the service should run. The one on PATH by preference — on a
 * Homebrew Mac `process.execPath` resolves to `/opt/homebrew/Cellar/bun/<v>/bin/bun`,
 * a path the next `brew upgrade` deletes, whereas `/opt/homebrew/bin/bun` is
 * the symlink that survives it. bun.sh's fallbacks are absolute already.
 */
export function bunPath(): string {
  // Refuse a bun that lives under the checkout: the service must not run a
  // binary a dependency dropped there (pentest M4; the PATH is also cleaned of
  // node_modules/.bin in main()). Fall back to the interpreter running this.
  const found = Bun.which("bun");
  if (found && !unstableBun(found)) return found;
  return process.execPath;
}

/**
 * A bun that must never be written into a service unit.
 *
 * Two kinds. A `node_modules/.bin/bun` is the supply-chain one (pentest M4).
 * The other was found by installing on a real Ubuntu (2026-09-04): `bun run`
 * creates a node-compatibility shim directory — `/tmp/bun-node-<hash>` on
 * Linux, under `$TMPDIR` on macOS — and *prepends it to PATH*, so
 * `Bun.which("bun")` inside the startup hook answers with the shim rather than
 * the real binary. That path was going straight into `ExecStart=`, and /tmp
 * does not survive a reboot: the service came back pointing at a binary that
 * no longer existed and failed forever under `Restart=always`. The hook masked
 * it by re-rendering the unit on every herdr start, so it only bit a box that
 * rebooted without one. `process.execPath` is the real binary in exactly this
 * case, which is why the fallback is right and the preference was wrong.
 */
function unstableBun(path: string): boolean {
  return path.includes("/node_modules/") || path.includes("/bun-node-") || path.startsWith(`${tmpdir()}/`);
}

/** What the service runs with. The .env decides PORT and HOST; this mirrors PORT so the plist says it too. */
export function serviceSpec(layout: Layout, env: Map<string, string>, bun = bunPath()): ServiceSpec {
  // The hook's own PATH is herdr's, which is the user's shell PATH: the best
  // available guess at what the sidecar needs to find `bash`, `claude` and
  // `codex`. bun's own directory goes first regardless. `bun run` prepends
  // every ancestor's node_modules/.bin to its child's PATH; those are noise.
  const inherited = (process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin")
    .split(":")
    // Same two exclusions as `bunPath`, for the same reasons: a dependency's
    // .bin must not be on the service's PATH, and bun's temporary node shim
    // would be a stale entry the moment /tmp is cleared.
    .filter((dir) => !dir.endsWith("/node_modules/.bin") && !unstableBun(`${dir}/x`));
  const relay = relayUrlFor(env);
  return {
    bun,
    root: layout.root,
    logPath: layout.logPath,
    env: {
      HERDR_SOCKET_PATH: layout.socketPath,
      SHAHI_ENV_FILE: layout.envFile,
      SHAHI_DATA: layout.dataPath,
      WEB_ROOT: layout.webRoot,
      PORT: String(portOf(layout, env)),
      // The .env is loaded by the sidecar itself; the relay default is not in
      // it, so it rides in the service's environment (see the header).
      ...(relay ? { RELAY_URL: relay } : {}),
      // What the manager needs to ask this same herdr whether the plugin is
      // still installed and enabled, and to remove the service when it is not
      // (releases/registration.ts): the id herdr registered, its binary, and
      // the configuration root it was started with.
      SHAHI_PLUGIN_ID: pluginId(),
      ...(process.env.HERDR_BIN_PATH ? { HERDR_BIN_PATH: process.env.HERDR_BIN_PATH } : {}),
      ...(process.env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } : {}),
      HOME: homedir(),
      PATH: [...new Set([dirname(bun), ...inherited])].join(":"),
    },
  };
}

/** The .env's PORT, or why it is not one and which file to fix: the unit and the address are both made from it. */
function portOf(layout: Layout, env: Map<string, string>): number {
  try {
    return parsePort(env.get("PORT"));
  } catch (err) {
    throw new Error(`${message(err)} Fix it in ${layout.envFile}, then:  ${herdr()} plugin action invoke shahi.restart`);
  }
}

function address(layout: Layout, env: Map<string, string>): { host: string; port: number; url: string } {
  const host = env.get("HOST") ?? "127.0.0.1";
  const port = portOf(layout, env);
  return { host, port, url: `http://${host}:${port}` };
}

async function meta(url: string): Promise<ServerInfo | null> {
  try {
    const res = await fetch(`${url}/api/meta`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return null;
    const info = (await res.json()) as Partial<ServerInfo>;
    return typeof info.serverId === "string" ? (info as ServerInfo) : null;
  } catch {
    return null;
  }
}

/**
 * A session signed with this install's own key — the same trick as pair.ts.
 * Anyone who can read the .env already owns the server.
 */
function ownSession(env: Map<string, string>): string | null {
  const secret = env.get("SESSION_SECRET");
  if (!secret) return null;
  const auth = new Auth({ passcodeHash: "", sessionSecret: secret, sessionTtlMs: 60_000 });
  return auth.cookie(auth.issue()).split(";")[0]!;
}

/**
 * Whose server answers at `url`: this install's, someone else's, or none.
 *
 * An answering /api/meta proved nothing: any Shahi has one — another user's,
 * or a development checkout on the default port — and setup, status and the
 * pair popup all reported that server as this install running, while the
 * real sidecar crash-looped on EADDRINUSE and pair.ts failed with a 401
 * blaming SESSION_SECRET (pre-release bug hunt). Only this install's sidecar
 * accepts a session signed with this install's key. /api/auth/status answers
 * that on every API version, before any version check.
 */
export async function whoAnswers(url: string, env: Map<string, string>): Promise<"ours" | "other" | "none"> {
  const cookie = ownSession(env);
  let res: Response;
  try {
    res = await fetch(`${url}/api/auth/status`, { headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(3_000) });
  } catch {
    return "none";
  }
  try {
    if (res.ok && ((await res.json()) as { authenticated?: unknown }).authenticated === true) return "ours";
  } catch { /* not a Shahi */ }
  return "other";
}

/** Why a sidecar cannot listen, and the one thing to change. */
function portTaken(layout: Layout, url: string): string {
  return [
    `Another program is answering at ${url}, and it is not this install's Shahi: it does not accept this install's session key.`,
    "Shahi cannot listen there while it does. It may be another user's Shahi or a development checkout.",
    `  Put PORT=<a free port> in ${layout.envFile}, then:  ${herdr()} plugin action invoke shahi.restart`,
  ].join("\n");
}

/**
 * How long setup waits for the sidecar: as long as the manager allows a
 * release to become ready. It waited 6 s, and a healthy cold start measured
 * up to 7.8 s on a loaded VM, so setup reported "not answering … The log
 * says why" and toasted "Shahi did not start" for a service that answered a
 * moment later (pre-release bug hunt).
 */
const START_MS = 30_000;

/**
 * The manager's own account of a service that exited, if it wrote one after
 * `since`: it outlives its crashing child, so the service manager keeps
 * reporting "running" throughout. Older records are about an earlier start.
 */
export function managerFailure(managerRoot: string, since: number): string | null {
  try {
    const path = join(managerRoot, "status.json");
    if (statSync(path).mtimeMs < since) return null;
    const status = readJson<ComputerUpdate>(path);
    return status?.phase === "failed" ? status.message ?? "The service exited." : null;
  } catch {
    return null;
  }
}

type Start =
  | { state: "answering"; info: ServerInfo | null }
  | { state: "taken" }
  | { state: "starting" }
  | { state: "failed"; why: string | null };

/** Bounded: the hook must exit whether or not the server comes up. */
export async function waitForStart(
  url: string,
  env: Map<string, string>,
  service: Service,
  managerRoot: string,
  since: number,
  ms = START_MS,
): Promise<Start> {
  const until = Date.now() + ms;
  let stoppedSince: number | null = null;
  for (;;) {
    const who = await whoAnswers(url, env);
    if (who === "ours") return { state: "answering", info: await meta(url) };
    if (who === "other") return { state: "taken" };
    const why = managerFailure(managerRoot, since);
    if (why) return { state: "failed", why };
    // A service that stays stopped will not answer however long this waits.
    // A few seconds' grace, because launchd and systemd can report a service
    // they have just been told to start as not running yet.
    if (service.status().running) stoppedSince = null;
    else if (Date.now() - (stoppedSince ??= Date.now()) >= 5_000) return { state: "failed", why: null };
    if (Date.now() >= until) return { state: "starting" };
    await Bun.sleep(250);
  }
}

async function deviceCount(url: string, env: Map<string, string>): Promise<number | null> {
  const cookie = ownSession(env);
  if (!cookie) return null;
  try {
    const res = await fetch(`${url}/api/devices`, {
      headers: { cookie, "x-shahi-api": String(SHAHI_API_VERSION) },
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return null;
    return ((await res.json()) as DeviceList).devices.length;
  } catch {
    return null;
  }
}

function where(layout: Layout, service: Service): string {
  return [
    `  ${service.kind.padEnd(9)} ${service.path}`,
    `  secrets   ${layout.envFile}`,
    `  data      ${layout.dataPath}`,
    `  log       ${layout.logPath}`,
  ].join("\n");
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** What a setup did, for whoever reports it: a toast from the hook, nothing from the popup (it is on screen). */
export interface Installed {
  /** Where the sidecar was when setup stopped waiting for it. */
  state: Start["state"];
  relayUrl: string | null;
  relayDefaulted: boolean;
  /** A passcode was chosen, and printed, by this run. */
  passcode: boolean;
  linger: string | null;
}

/**
 * Secrets, the approved release, the service, and what to know about them.
 * `newPasscode` replaces the passcode (the `reset-passcode` action); otherwise
 * one is chosen only when there is none.
 */
export async function install(layout: Layout, service: Service, opts: { newPasscode?: boolean } = {}): Promise<Installed> {
  mkdirSync(layout.configDir, { recursive: true });
  mkdirSync(layout.stateDir, { recursive: true });

  // The release before the passcode. A passcode is shown once and only its
  // hash is kept, and this is the step a first run fails at — offline, behind
  // a proxy, an unapproved herdr or bun. Run after the hash was written, it
  // used up a passcode nobody ever saw, and every later run kept that hash
  // (pre-release review, reproduced with the catalog download failing).
  let managerRoot: string;
  let notice: string | null | undefined;
  try {
    ({ root: managerRoot, notice } = await bootstrap(layout));
  } catch (err) {
    throw new Error(`Could not set up Shahi's approved release: ${message(err)}`, { cause: err });
  }

  const existing = readEnvFile(layout.envFile);
  // An empty PASSCODE_HASH_B64 is a working configuration for a checkout (the
  // gate is off) and never for a plugin: this port is full control of every
  // agent on the machine, so the plugin always keeps a passcode.
  const passcode = opts.newPasscode || !existing.get("PASSCODE_HASH_B64") ? randomPasscode() : null;
  const { env } = await ensureSecrets(existing, { passcode });
  // Written even when nothing changed: it is the cheapest way to make sure a
  // hand-made file (`PORT=7275`, at whatever mode the shell gave it) ends up
  // 0600 now that the session key is in it.
  writeEnvFile(layout.envFile, env);
  // Printed the moment its hash is kept, so nothing that fails below can
  // take the only sight of it with it.
  if (passcode) {
    console.log(`  Passcode  ${passcode}\n  Shown this once; only its hash is kept. A phone paired by code never types it.\n`);
  }

  const spec = serviceSpec(layout, env);
  const managed = { ...spec, root: managerRoot, entry: join(managerRoot, "manager.js"), env: { ...spec.env, SHAHI_MANAGER_ROOT: managerRoot } };
  const { url } = address(layout, env);
  const requestInstall = () => {
    try { requestUpdate(managerRoot, { action: "install" }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  };
  const since = Date.now();
  let start: Start | undefined;
  if (service.kind === "none") {
    // Nothing here supervises the sidecar, so on every herdr start a sidecar
    // this person started by hand was reported as "not set up": the hook
    // failed, toasted so, and skipped the update request a reinstall should
    // leave (pre-release bug hunt). The request goes first, for the manager
    // running now or the one started next.
    requestInstall();
    const who = await whoAnswers(url, env);
    if (who === "other") start = { state: "taken" };
    else if (who === "none") service.install(managed); // the hand-over: what to start, and how
    else {
      start = { state: "answering", info: await meta(url) };
      console.log(`Shahi is running at ${url}, started outside herdr: no systemd here, so this machine's own init keeps it running. What it runs:\n  ${renderCommand(managed)}\n`);
    }
  } else {
    service.install(managed);
    requestInstall();
  }
  start ??= await waitForStart(url, env, service, managerRoot, since);
  const relayUrl = relayUrlFor(env);
  const relayDefaulted = !env.has("RELAY_URL");
  if (start.state === "answering") {
    console.log(`Shahi's connection service is running at ${url}.`);
    console.log(
      relayUrl
        ? `  relay     ${relayUrl}${relayDefaulted ? ` (Shahi's relay, the default; RELAY_URL= in ${layout.envFile} turns it off)` : ""}`
        : "  relay     off (RELAY_URL is empty): reachable directly only",
    );
  } else if (start.state === "taken") {
    console.log(portTaken(layout, url));
  } else if (start.state === "starting") {
    console.log(`Shahi was started and is still starting; it has not answered at ${url} yet. ${herdr()} plugin action invoke shahi.status shows when it does.`);
  } else {
    console.log(`Shahi was started but is not running${start.why ? `: ${start.why}` : "."} The log says why:\n  ${layout.logPath}`);
  }
  // An install that went ahead in the recovery state (an unapproved herdr or
  // bun) says so, and names the versions, instead of looking like success.
  if (notice) console.log(`\n  ${notice}`);
  const linger = lingerHint(process.platform, lingerValue(), process.env.USER ?? "$USER");
  if (linger) console.log(`\n  ${linger}\n`);
  console.log(where(layout, service));
  console.log(`\n  ${pairHint()}\n  ${KEY_HINT}`);
  return { state: start.state, relayUrl, relayDefaulted, passcode: passcode !== null, linger };
}

/**
 * The startup hook and the `restart` and `reset-passcode` actions: their
 * output lands in the plugin log, so a toast (when herdr shows them) says
 * where to look. herdr ignores a failed startup hook, so a failure is toasted
 * too — it used to be silent everywhere but the log (pre-release review).
 */
export async function setup(layout: Layout, service: Service, opts: { newPasscode?: boolean } = {}): Promise<number> {
  let done: Installed;
  try {
    done = await install(layout, service, opts);
  } catch (err) {
    notify(
      "Shahi is not set up",
      `${message(err).split("\n")[0]} The rest is in: ${herdr()} plugin log list --plugin shahi. To set up in front of you: ${herdr()} plugin action invoke shahi.pair`,
    );
    throw err;
  }
  if (done.state === "taken") {
    notify("Shahi cannot start: its port is taken", `Another program answers on Shahi's port. Put PORT=<a free port> in ${layout.envFile}, then: ${herdr()} plugin action invoke shahi.restart`);
    return 1;
  }
  if (done.state === "failed") {
    notify("Shahi did not start", `See ${layout.logPath}`);
    return 1;
  }
  if (done.state === "starting") {
    notify("Shahi is starting", `It has not answered yet; ${herdr()} plugin action invoke shahi.status shows when it does.`);
    return 0;
  }
  notify(
    "Shahi is running",
    [
      `${pairHint()}.`,
      ...(done.relayUrl ? [done.relayDefaulted ? "Reachable from anywhere through Shahi's relay (RELAY_URL= in the plugin's .env turns that off)." : "Reachable through your relay."] : []),
      ...(done.passcode ? [`The passcode is in the plugin log: ${herdr()} plugin log list --plugin shahi (a scanned code never needs it).`] : []),
      ...(done.linger ? [done.linger] : []),
    ].join(" "),
  );
  return 0;
}

export async function status(layout: Layout, service: Service): Promise<number> {
  const env = readEnvFile(layout.envFile);
  const { url } = address(layout, env);
  const state = service.status();
  const who = await whoAnswers(url, env);
  // Another program's version, relay and devices are not this install's.
  const info = who === "ours" ? await meta(url) : null;
  const devices = info ? await deviceCount(url, env) : null;
  // The manager outlives a crashing sidecar, so "running" above can be true
  // of a service that never answers; the manager's own record says why.
  const why = who === "none" ? managerFailure(join(layout.stateDir, "managed"), 0) : null;

  const serviceLine = service.kind === "none"
    ? `none (no systemd): you run it — ${herdr()} plugin action invoke shahi.restart prints the command`
    : !state.installed
    ? `not installed — restart herdr, or: ${herdr()} plugin action invoke shahi.restart`
    : state.running
      ? `running${state.pid ? ` (pid ${state.pid})` : ""}`
      : "installed, not running";
  const relayUrl = relayUrlFor(env);
  const relayLine = !relayUrl
    ? "off (RELAY_URL is empty): reachable over SSH only"
    : info?.relay
      ? `${info.relay.url} — ${info.relay.connected ? "connected" : "dialling"}`
      : relayUrl;
  console.log(`  service   ${serviceLine}`);
  console.log(`  address   ${url}`);
  console.log(`  relay     ${relayLine}`);
  console.log(
    `  phone     ${relayUrl ? "through the relay, from anywhere" : "no pairing without a relay: set RELAY_URL, or reach this box over SSH"}`,
  );
  console.log(
    info
      ? `  api       answering — shahi ${info.serverVersion}, api ${info.api.min}–${info.api.max}, herdr ${info.herdr?.version} (protocol ${info.herdr?.protocol})`
      : who === "other"
        ? `  api       port taken — ${portTaken(layout, url).split("\n").join("\n            ")}`
        : `  api       not answering at ${url}/api/meta${why ? ` — ${why}` : ""}`,
  );
  console.log(`  devices   ${devices === null ? "unknown" : `${devices} paired`}`);
  console.log(where(layout, service));
  console.log(`  inspect   ${service.inspect}`);
  return info ? 0 : 1;
}

function logs(layout: Layout, args: string[]): void {
  const lines = Math.min(1000, Math.max(1, Number(args[args.indexOf("--lines") + 1]) || 80));
  for (const path of [layout.logPath, join(layout.stateDir, "operations.jsonl"), join(layout.configDir, "update.log")]) {
    if (!existsSync(path)) continue;
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      const bytes = Buffer.alloc(Math.min(size, 256 * 1024));
      readSync(fd, bytes, 0, bytes.length, size - bytes.length);
      const rows = bytes.toString("utf8").trimEnd().split("\n");
      if (size > bytes.length) rows.shift();
      console.log(`${path}\n${rows.slice(-lines).join("\n")}`);
    } finally { closeSync(fd); }
  }
}

/**
 * One line from the terminal — a popup is a PTY, so a chunk is a line.
 *
 * Through `process.stdin`, paused afterwards, and not `Bun.stdin.stream()`:
 * measured in the pre-release review, a stream reader keeps reading fd 0
 * after its lock is released, and swallowed the Enter meant for the pair.ts
 * started after it. Waiting before the QR is new, which is how it showed.
 */
export function readLine(): Promise<string> {
  return new Promise((resolve) => {
    const done = (chunk?: Buffer | string) => {
      process.stdin.off("data", done);
      process.stdin.off("end", done);
      process.stdin.pause();
      resolve(chunk ? String(chunk).trim() : "");
    };
    process.stdin.once("data", done);
    process.stdin.once("end", done);
    process.stdin.resume();
  });
}

/** What the pair popup does, apart from how, so its promises are testable without a service or a PTY. */
export interface PopupSteps {
  /** A sidecar of this plugin's is up and answering. */
  running(): Promise<boolean>;
  setup(): Promise<unknown>;
  /** pair.ts's fitted QR screen, which waits for Enter itself; its exit status. */
  showCode(): Promise<number>;
}

const popupFailed = () => [
  `Pairing did not start. Fix what is said above, then open this again:  ${herdr()} plugin action invoke shahi.pair`,
  `Service state and paths:  ${herdr()} plugin action invoke shahi.status, then  ${herdr()} plugin log list --plugin shahi`,
].join("\n  ");

/**
 * The popup's command. pair.ts owns the fitted screen and waits for Enter.
 *
 * It also does the setup when there is none: `herdr plugin install` cannot
 * run the startup hook (build commands get no plugin context), and the only
 * other way to run it is an action whose output lands in a log. This popup
 * is a PTY a person is looking at, so "install, then pair" is the whole flow
 * and the first run's passcode and paths print where they are read.
 *
 * herdr closes a popup the moment its command exits, so nothing printed here
 * may be followed by an exit or a screen change without an Enter in between
 * (pre-release review). A setup that failed — a catalog that would not
 * download, an unapproved herdr, a systemd with no user bus, a Linux with no
 * systemd at all — used to flash and vanish with the popup; and a setup that
 * worked had its passcode and lingering warning painted over within a second
 * by the QR's alternate screen, then closed with it.
 */
export async function pairPopup(prepare: () => PopupSteps, waitForEnter: () => Promise<unknown>): Promise<number> {
  try {
    const steps = prepare();
    if (!(await steps.running())) {
      console.log("Shahi is not running yet — setting it up first.\n");
      await steps.setup();
      console.log("\n  Press Enter to show the QR code.");
      await waitForEnter();
    }
    if ((await steps.showCode()) === 0) return 0;
  } catch (err) {
    console.log(`\n${message(err)}`);
  }
  console.log(`\n  ${popupFailed()}\n  Press Enter to close.`);
  await waitForEnter();
  return 1;
}

export function popupSteps(layout: Layout, service: Service, args: string[]): PopupSteps {
  return {
    // With no service manager nothing here can tell a sidecar started by hand
    // from none, so this install's sidecar answering is the whole test.
    running: async () => {
      const env = readEnvFile(layout.envFile);
      return (service.kind === "none" || service.status().running) && (await whoAnswers(address(layout, env).url, env)) === "ours";
    },
    // A sidecar that is not up has no code to show; what setup printed says why.
    setup: async () => {
      const done = await install(layout, service);
      if (done.state === "starting") throw new Error("Shahi has not answered yet, so there is no code to show. Open this again in a moment.");
      if (done.state !== "answering") throw new Error("Shahi is not running, so there is no code to show.");
    },
    // pair.ts puts on the code the relay the running sidecar reports, so only
    // the .env (for the session key and the port) needs naming.
    showCode: () =>
      Bun.spawn([process.execPath, "run", "server/scripts/pair.ts", "--popup", ...args], {
        cwd: layout.root,
        env: { ...process.env, SHAHI_ENV_FILE: layout.envFile },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }).exited,
  };
}

/** This plugin's id as herdr registered it — `shahi`, or whatever a fork was linked as. */
const pluginId = () => process.env.HERDR_PLUGIN_ID ?? "shahi";

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Why the popup did not open, and what works without one. herdr's
 * `plugin action invoke` answers "running" and exits 0 before this action has
 * even started, so the plugin log is the only place a failure can be read;
 * measured in the pre-release review against a headless herdr with no client
 * attached, it held only herdr's JSON `no active workspace`.
 */
export function openPairFailure(stderr: string, layout: Layout | null): string {
  let reason = stderr.trim();
  try { reason = (JSON.parse(reason) as { error?: { message?: string } }).error?.message ?? reason; } catch { /* not herdr's JSON */ }
  return [
    `Could not open the pairing popup: ${reason || "herdr gave no reason"}.`,
    ...(/no active workspace/.test(reason)
      ? [`The popup needs a herdr window, and no client is attached to this herdr. Run \`${herdr()}\` in a terminal to attach, then invoke shahi.pair again from there.`]
      : []),
    ...(layout
      ? [
          "Without a window, print a one-time pairing code as text (the browser app accepts it pasted):",
          `  cd ${quote(layout.root)} && SHAHI_ENV_FILE=${quote(layout.envFile)} ${quote(process.execPath)} run server/scripts/pair.ts --code-only`,
        ]
      : []),
  ].join("\n");
}

export function openPair(): number {
  const bin = process.env.HERDR_BIN_PATH ?? "herdr";
  const proc = Bun.spawnSync([bin, "plugin", "pane", "open", "--plugin", pluginId(), "--entrypoint", "pair"], {
    stdout: "inherit",
    stderr: "pipe",
  });
  if (proc.exitCode === 0) return 0;
  let layout: Layout | null = null;
  try { layout = layoutFromEnv(); } catch { /* the fallback command needs the paths; the reason does not */ }
  const said = openPairFailure(proc.stderr.toString(), layout);
  console.error(said);
  notify("Shahi could not open the pairing popup", said.split("\n")[0]!);
  return proc.exitCode || 1;
}

/**
 * The whole uninstall from one action: the service (which herdr knows nothing
 * about) and then, through herdr, the plugin itself. The service runs from the
 * state directory, not the checkout, so a plain `herdr plugin uninstall`
 * leaves it running until its manager next asks herdr and removes itself
 * (releases/registration.ts, within about a minute); this action removes it
 * first, so it is never reachable after the person asked for it to be gone.
 * The checkout vanishes under this very script, which is fine: bun has read
 * it. The config and state directories stay, because they hold the passcode,
 * the paired phones and the transcripts.
 */
function uninstall(layout: Layout, service: Service): number {
  service.remove();
  console.log(
    service.kind === "none"
      ? "No service was installed here; stop the sidecar wherever you started it."
      : `Stopped the sidecar and removed ${service.path}.`,
  );
  // Said before the plugin goes: its log goes with it, and this is the one
  // message the person needs — where their passcode and phones still are.
  const kept = `Kept, because they hold your passcode, your paired phones and your transcripts: ${layout.configDir} and ${layout.stateDir}. Delete those by hand if you mean it.`;
  console.log(`\n${kept}`);
  notify("Shahi removed", `${kept} If it is still listed: ${herdr()} plugin uninstall ${pluginId()}`);
  const bin = process.env.HERDR_BIN_PATH ?? "herdr";
  const proc = Bun.spawnSync([bin, "plugin", "uninstall", pluginId()], { stdout: "inherit", stderr: "inherit" });
  const gone = proc.exitCode === 0;
  if (!gone) console.log(`The service is gone, but herdr did not uninstall the plugin; run:  ${herdr()} plugin uninstall ${pluginId()}`);
  return gone ? 0 : 1;
}

export async function main(argv: string[]): Promise<number> {
  // `bun run` prepends every ancestor's node_modules/.bin to PATH, so a
  // dependency shipping a `bun` bin would be picked by bunPath() and become the
  // launchd/systemd-supervised service, and bare-name spawns (launchctl,
  // systemctl, tailscale) would resolve from .bin first (pentest M4). Strip
  // those entries once, before any which() or spawn in this process.
  process.env.PATH = (process.env.PATH ?? "")
    .split(":")
    .filter((dir) => !dir.endsWith("/node_modules/.bin"))
    .join(":");

  const verb = argv[0] as Verb | undefined;
  const args = argv.slice(1);
  if (!verb || !VERBS.includes(verb)) {
    console.error(`usage: shahi.ts <${VERBS.join("|")}>`);
    return 2;
  }
  if (verb === "open-pair") return openPair();
  const serviceHere = () => serviceFor(process.platform, homedir(), process.getuid?.() ?? 0);
  if (verb === "pair") {
    // Built inside the popup's guard, so even a missing variable is read before the popup closes.
    return pairPopup(() => popupSteps(layoutFromEnv(), serviceHere(), args), args.includes("--code-only") ? async () => {} : readLine);
  }

  const layout = layoutFromEnv();
  const service = serviceHere();
  switch (verb) {
    case "setup":
    case "restart":
      return setup(layout, service);
    case "reset-passcode":
      // Only its hash is kept, so a forgotten passcode is replaced, not
      // recovered. Through the whole setup, so the sidecar restarts with it.
      return setup(layout, service, { newPasscode: true });
    case "status":
      return status(layout, service);
    case "stop":
      service.stop();
      console.log(`Stopped. It comes back on the next herdr start, or:  ${herdr()} plugin action invoke shahi.restart`);
      return 0;
    case "logs":
      logs(layout, args);
      return 0;
    case "uninstall":
      return uninstall(layout, service);
  }
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
