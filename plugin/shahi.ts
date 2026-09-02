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
 * "install, then pair" is the whole flow and its output is on screen. The
 * passcode digits stay out of the toast: a toast is also every attached
 * client, a screen share, and on some terminals the OS notification centre.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname } from "node:path";
import { SHAHI_API_VERSION, type DeviceList, type ServerInfo } from "@shahi/shared";
import { Auth } from "../server/lib/auth";
import { phoneEndpoint, tailscaleStatus } from "../server/lib/endpoint";
import { ensureSecrets, randomPasscode, readEnvFile, writeEnvFile } from "../server/lib/secrets";
import { layoutFromEnv, type Layout } from "./layout";
import { serviceFor, type Service, type ServiceSpec } from "./service";

export const VERBS = ["setup", "status", "restart", "stop", "logs", "pair", "open-pair", "uninstall"] as const;
type Verb = (typeof VERBS)[number];

/** herdr 0.8.2 has no menu for plugin actions: the CLI, or a key the person binds. */
const PAIR_HINT = "Pair a phone:  herdr plugin action invoke shahi.pair";
const KEY_HINT = 'or bind a key in herdr\'s config.toml:  [[keys.command]] key = "prefix+P", type = "plugin_action", command = "shahi.pair"';

/** Shahi's relay: a blind pipe (docs/relay.md). The plugin's default; any Worker deployed from `relay/` works the same. */
export const DEFAULT_RELAY_URL = "https://shahi-relay.yasserd99.workers.dev";

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
  const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
  try {
    Bun.spawnSync([herdr, "notification", "show", title, "--body", body, "--sound", "none"], {
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
  if (found && !found.includes("/node_modules/")) return found;
  return process.execPath;
}

/** What the service runs with. The .env decides PORT and HOST; this mirrors PORT so the plist says it too. */
export function serviceSpec(layout: Layout, env: Map<string, string>, bun = bunPath()): ServiceSpec {
  // The hook's own PATH is herdr's, which is the user's shell PATH: the best
  // available guess at what the sidecar needs to find `bash`, `claude` and
  // `codex`. bun's own directory goes first regardless. `bun run` prepends
  // every ancestor's node_modules/.bin to its child's PATH; those are noise.
  const inherited = (process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin")
    .split(":")
    .filter((dir) => !dir.endsWith("/node_modules/.bin"));
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
      PORT: env.get("PORT") ?? "7171",
      // The .env is loaded by the sidecar itself; the relay default is not in
      // it, so it rides in the service's environment (see the header).
      ...(relay ? { RELAY_URL: relay } : {}),
      HOME: homedir(),
      PATH: [...new Set([dirname(bun), ...inherited])].join(":"),
    },
  };
}

function address(env: Map<string, string>): { host: string; port: number; url: string } {
  const host = env.get("HOST") ?? "127.0.0.1";
  const port = Number(env.get("PORT") ?? 7171);
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

/** Bounded: the hook must exit promptly whether or not the server comes up. */
async function waitForMeta(url: string, ms = 6_000): Promise<ServerInfo | null> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const info = await meta(url);
    if (info) return info;
    await Bun.sleep(250);
  }
  return null;
}

async function deviceCount(url: string, env: Map<string, string>): Promise<number | null> {
  const secret = env.get("SESSION_SECRET");
  if (!secret) return null;
  // The same trick as pair.ts: sign a session with the server's own key.
  // Anyone who can read the .env already owns the server.
  const auth = new Auth({ passcodeHash: "", sessionSecret: secret, sessionTtlMs: 60_000 });
  try {
    const res = await fetch(`${url}/api/devices`, {
      headers: { cookie: auth.cookie(auth.issue()).split(";")[0]!, "x-shahi-api": String(SHAHI_API_VERSION) },
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

async function install(layout: Layout, service: Service): Promise<void> {
  mkdirSync(layout.configDir, { recursive: true });
  mkdirSync(layout.stateDir, { recursive: true });

  const existing = readEnvFile(layout.envFile);
  // An empty PASSCODE_HASH_B64 is a working configuration for a checkout (the
  // gate is off) and never for a plugin: this port is full control of every
  // agent on the machine, so the plugin always keeps a passcode.
  const passcode = existing.get("PASSCODE_HASH_B64") ? null : randomPasscode();
  const { env } = await ensureSecrets(existing, { passcode });
  // Written even when nothing changed: it is the cheapest way to make sure a
  // hand-made file (`PORT=7275`, at whatever mode the shell gave it) ends up
  // 0600 now that the session key is in it.
  writeEnvFile(layout.envFile, env);

  service.install(serviceSpec(layout, env));

  const { url } = address(env);
  const info = await waitForMeta(url);
  const relayUrl = relayUrlFor(env);
  const relayDefaulted = !env.has("RELAY_URL");
  if (info) {
    console.log(`Shahi is running at ${url} — herdr ${info.herdr?.version}, protocol ${info.herdr?.protocol}.`);
    console.log(
      relayUrl
        ? `  relay     ${relayUrl}${relayDefaulted ? ` (Shahi's relay, the default; RELAY_URL= in ${layout.envFile} turns it off)` : ""}`
        : "  relay     off (RELAY_URL is empty): reachable directly only",
    );
  } else {
    console.log(`Shahi was started but is not answering at ${url} yet. The log says why:\n  ${layout.logPath}`);
  }
  if (passcode) {
    console.log(
      `\n  Passcode  ${passcode}\n` +
        "  Shown this once; only its hash is kept. A phone paired by code never types it.\n",
    );
  }
  const linger = lingerHint(process.platform, lingerValue(), process.env.USER ?? "$USER");
  if (linger) console.log(`\n  ${linger}\n`);
  console.log(where(layout, service));
  console.log(`\n  ${PAIR_HINT}\n  ${KEY_HINT}`);

  if (info) {
    notify(
      "Shahi is running",
      [
        `${PAIR_HINT}.`,
        ...(relayUrl ? [relayDefaulted ? "Reachable from anywhere through Shahi's relay (RELAY_URL= in the plugin's .env turns that off)." : "Reachable through your relay."] : []),
        ...(passcode ? ["The passcode is in the plugin log: herdr plugin log list --plugin shahi (a scanned code never needs it)."] : []),
        ...(linger ? [linger] : []),
      ].join(" "),
    );
  } else {
    notify("Shahi did not start", `See ${layout.logPath}`);
  }
}

async function status(layout: Layout, service: Service): Promise<number> {
  const env = readEnvFile(layout.envFile);
  const { host, port, url } = address(env);
  const state = service.status();
  const info = await meta(url);
  const phone = phoneEndpoint(await tailscaleStatus(), host, port);
  const devices = info ? await deviceCount(url, env) : null;

  const serviceLine = !state.installed
    ? "not installed — restart herdr, or: herdr plugin action invoke shahi.restart"
    : state.running
      ? `running${state.pid ? ` (pid ${state.pid})` : ""}`
      : "installed, not running";
  const relayUrl = relayUrlFor(env);
  const relayLine = !relayUrl
    ? "off (RELAY_URL is empty): reachable directly only"
    : info?.relay
      ? `${info.relay.url} — ${info.relay.connected ? "connected" : "dialling"}`
      : relayUrl;
  console.log(`  service   ${serviceLine}`);
  console.log(`  address   ${url}`);
  console.log(`  relay     ${relayLine}`);
  console.log(
    `  phone     ${phone || (relayUrl ? "through the relay, from anywhere" : "no address to give a phone yet: set RELAY_URL, bind HOST off loopback, or put `tailscale serve` in front")}`,
  );
  console.log(
    info
      ? `  api       answering — shahi ${info.serverVersion}, api ${info.api.min}–${info.api.max}, herdr ${info.herdr?.version} (protocol ${info.herdr?.protocol})`
      : `  api       not answering at ${url}/api/meta`,
  );
  console.log(`  devices   ${devices === null ? "unknown" : `${devices} paired`}`);
  console.log(where(layout, service));
  console.log(`  inspect   ${service.inspect}`);
  return info ? 0 : 1;
}

function logs(layout: Layout, args: string[]): void {
  const lines = Number(args[args.indexOf("--lines") + 1]) || 80;
  if (!existsSync(layout.logPath)) {
    console.log(`No log yet at ${layout.logPath}.`);
    return;
  }
  const all = readFileSync(layout.logPath, "utf8").replace(/\n$/, "").split("\n");
  console.log(all.slice(-lines).join("\n"));
  console.log(`\n  (last ${Math.min(lines, all.length)} of ${all.length} lines — tail -f ${layout.logPath} to follow)`);
}

/** One line from the terminal — a popup is a PTY, so a chunk is a line. */
async function readLine(): Promise<string> {
  const reader = Bun.stdin.stream().getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  return value ? new TextDecoder().decode(value).trim() : "";
}

/**
 * The popup's command. pair.ts prints and exits; the popup closes with it, so
 * hold it open.
 *
 * It also does the setup when there is none: `herdr plugin install` cannot
 * run the startup hook (build commands get no plugin context), and the only
 * other way to run it is an action whose output lands in a log. This popup
 * is a PTY a person is looking at, so "install, then pair" is the whole flow
 * and the first run's passcode and paths print where they are read.
 */
async function pair(layout: Layout, service: Service, args: string[]): Promise<void> {
  const before = address(readEnvFile(layout.envFile));
  if (!service.status().running || !(await meta(before.url))) {
    console.log("Shahi is not running yet — setting it up first.\n");
    await install(layout, service);
    console.log("");
  }
  const env = readEnvFile(layout.envFile);
  const { host, port } = address(env);
  // With a relay the code needs no typed address: the phone goes through the
  // relay, and pair.ts fills the code's endpoint field with the box's own.
  if (!args.includes("--endpoint") && !relayUrlFor(env) && !phoneEndpoint(await tailscaleStatus(), host, port)) {
    // pair.ts would stop here and say to run it again with --endpoint — which
    // from inside a popup means closing it and typing an env-laden command by
    // hand. Ask for the address here instead; the code is still probed before
    // it is printed, so a wrong one is reported on this screen.
    console.log(
      "This box is bound to loopback and has no Tailscale name, so it cannot tell\n" +
        "what address the phone will use. Type it, then Enter — for example\n" +
        `https://box.tailnet.ts.net, or http://<this machine's address>:${port}\n`,
    );
    const typed = await readLine();
    if (typed) args = [...args, "--endpoint", typed];
  }
  const proc = Bun.spawn([process.execPath, "run", "server/scripts/pair.ts", ...args], {
    cwd: layout.root,
    // The relay the service actually dials, default included (pair.ts reads
    // the .env and the environment, and the environment wins).
    env: { ...process.env, SHAHI_ENV_FILE: layout.envFile, RELAY_URL: relayUrlFor(env) ?? "" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await proc.exited) !== 0) {
    console.log("\n  Pairing failed. Is Shahi running?  herdr plugin action invoke shahi.status");
  }
  console.log("  Press Enter to close.");
  await readLine();
}

/** This plugin's id as herdr registered it — `shahi`, or whatever a fork was linked as. */
const pluginId = () => process.env.HERDR_PLUGIN_ID ?? "shahi";

function openPair(): number {
  const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
  const proc = Bun.spawnSync([herdr, "plugin", "pane", "open", "--plugin", pluginId(), "--entrypoint", "pair"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  return proc.exitCode ?? 1;
}

/**
 * The whole uninstall from one action: the service (which herdr knows nothing
 * about) and then, through herdr, the plugin itself. Order matters — the
 * other way round, the service would keep running from a directory that no
 * longer exists. The checkout vanishes under this very script, which is fine:
 * bun has read it. The config and state directories stay, because they hold
 * the passcode, the paired phones and the transcripts.
 */
function uninstall(layout: Layout, service: Service): number {
  service.remove();
  console.log(`Stopped the sidecar and removed ${service.path}.`);
  // Said before the plugin goes: its log goes with it, and this is the one
  // message the person needs — where their passcode and phones still are.
  const kept = `Kept, because they hold your passcode, your paired phones and your transcripts: ${layout.configDir} and ${layout.stateDir}. Delete those by hand if you mean it.`;
  console.log(`\n${kept}`);
  notify("Shahi removed", `${kept} If it is still listed: herdr plugin uninstall ${pluginId()}`);
  const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
  const proc = Bun.spawnSync([herdr, "plugin", "uninstall", pluginId()], { stdout: "inherit", stderr: "inherit" });
  const gone = proc.exitCode === 0;
  if (!gone) console.log(`The service is gone, but herdr did not uninstall the plugin; run:  herdr plugin uninstall ${pluginId()}`);
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

  const layout = layoutFromEnv();
  const service = serviceFor(process.platform, homedir(), process.getuid?.() ?? 0);

  switch (verb) {
    case "setup":
    case "restart":
      await install(layout, service);
      return 0;
    case "status":
      return status(layout, service);
    case "stop":
      service.stop();
      console.log("Stopped. It comes back on the next herdr start, or:  herdr plugin action invoke shahi.restart");
      return 0;
    case "logs":
      logs(layout, args);
      return 0;
    case "pair":
      await pair(layout, service, args);
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
