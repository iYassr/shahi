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
 *   sh plugin/bun.sh run plugin/shahi.ts uninstall   remove the service; leave the data
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
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { SHAHI_API_VERSION, type DeviceList, type ServerInfo } from "@shahi/shared";
import { Auth } from "../server/lib/auth";
import { phoneEndpoint, tailscaleStatus } from "../server/lib/endpoint";
import { ensureSecrets, randomPasscode, readEnvFile, writeEnvFile } from "../server/lib/secrets";
import { layoutFromEnv, type Layout } from "./layout";
import { serviceFor, type Service, type ServiceSpec } from "./service";

export const VERBS = ["setup", "status", "restart", "stop", "logs", "pair", "open-pair", "uninstall"] as const;
type Verb = (typeof VERBS)[number];

/**
 * The bun the service should run. The one on PATH by preference — on a
 * Homebrew Mac `process.execPath` resolves to `/opt/homebrew/Cellar/bun/<v>/bin/bun`,
 * a path the next `brew upgrade` deletes, whereas `/opt/homebrew/bin/bun` is
 * the symlink that survives it. bun.sh's fallbacks are absolute already.
 */
export function bunPath(): string {
  return Bun.which("bun") ?? process.execPath;
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
  if (info) {
    console.log(`Shahi is running at ${url} — herdr ${info.herdr.version}, protocol ${info.herdr.protocol}.`);
  } else {
    console.log(`Shahi was started but is not answering at ${url} yet. The log says why:\n  ${layout.logPath}`);
  }
  if (passcode) {
    console.log(
      `\n  Passcode  ${passcode}\n` +
        "  Shown this once; only its hash is kept. A phone paired by code never types it.\n",
    );
  }
  console.log(where(layout, service));
  console.log("\n  Pair a phone:  herdr plugin action invoke shahi.pair");
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
  console.log(`  service   ${serviceLine}`);
  console.log(`  address   ${url}`);
  console.log(
    `  phone     ${phone || "no address to give a phone yet: bind HOST off loopback, or put `tailscale serve` in front"}`,
  );
  console.log(
    info
      ? `  api       answering — shahi ${info.serverVersion}, api ${info.api.min}–${info.api.max}, herdr ${info.herdr.version} (protocol ${info.herdr.protocol})`
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

/** The popup's command. pair.ts prints and exits; the popup closes with it, so hold it open. */
async function pair(layout: Layout, args: string[]): Promise<void> {
  const { host, port } = address(readEnvFile(layout.envFile));
  if (!args.includes("--endpoint") && !phoneEndpoint(await tailscaleStatus(), host, port)) {
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
    env: { ...process.env, SHAHI_ENV_FILE: layout.envFile },
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

function openPair(): number {
  const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
  const proc = Bun.spawnSync([herdr, "plugin", "pane", "open", "--plugin", "shahi", "--entrypoint", "pair"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  return proc.exitCode ?? 1;
}

function uninstall(layout: Layout, service: Service): void {
  service.remove();
  console.log(`Removed ${service.path} and stopped the sidecar.\n`);
  console.log("Kept, because they hold your passcode, your paired phones and your transcripts:");
  console.log(`  ${layout.configDir}\n  ${layout.stateDir}`);
  console.log("\nDelete those by hand if you mean it. Then:  herdr plugin uninstall shahi");
}

export async function main(argv: string[]): Promise<number> {
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
      await pair(layout, args);
      return 0;
    case "uninstall":
      uninstall(layout, service);
      return 0;
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
