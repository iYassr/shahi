import { existsSync, rmSync, readFileSync, renameSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Auth } from "../../server/lib/auth";
import { loadConfig, type Config } from "../../server/lib/config";
import { HerdrClient } from "../../server/lib/herdr-client";
import { type ComputerUpdate, type ControlHandshake } from "@shahi/shared";
import { serviceFor } from "../service";
import { CATALOG_URL, download, selectRelease, verifyCatalog, sha256, type Catalog, type Release } from "./catalog";
import { confirmedRemoved, herdrBinary, registration, removalNotice } from "./registration";
import { atomicJson, installation, readJson, releaseDirectory, type UpdateRequest } from "./storage";
import { stage } from "./stage";
import { beginTransaction, finishTransaction, type Runner } from "./transaction";

/** Often enough that a removed plugin stops being reachable within a minute; a check is two short herdr CLI calls. */
const REGISTRATION_CHECK_MS = 30_000;
const CATALOG_CHECK_MS = 6 * 60 * 60_000;

/**
 * How long to wait before starting a service that keeps failing: 3 s after
 * the first quick exit, doubling to five minutes. A run of a minute or more
 * counts as healthy and starts the count again. It was every ~4 s forever,
 * and with the port taken that was 8 crashes and 44 KB of log in 30 s, about
 * 127 MB a day (pre-release bug hunt).
 */
export const HEALTHY_RUN_MS = 60_000;
export function respawnDelay(failures: number): number {
  return Math.min(3_000 * 2 ** Math.max(0, failures - 1), 5 * 60_000);
}

/**
 * Still running. A process killed by a signal — the OOM killer, a crash —
 * keeps exitCode null in Bun and sets signalCode instead, so the exitCode
 * test alone never noticed it and the service stayed down (measured on Bun
 * 1.4.0 while fixing the respawn loop).
 */
const running = (p: ReturnType<typeof Bun.spawn> | undefined) => !!p && p.exitCode === null && p.signalCode === null;
const seconds = (ms: number) => `${ms < 10_000 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000)} s`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s*\n\s*/g, " ");

export async function manage(root: string) {
  const managerHash = sha256(readFileSync(import.meta.path));
  // Read before this manager writes anything: a manager that replaced itself
  // after an update left "restarting" for this one to finish (see reconcile).
  const handedOver = readJson<ComputerUpdate>(join(root, "status.json"))?.phase === "restarting";
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let startedAt = 0;
  let closing = false;
  let status: ComputerUpdate = { managed: true, phase: "idle", channel: installation(root)!.channel, current: installation(root)!.active.version };
  const save = (patch: Partial<ComputerUpdate>) => {
    status = { ...status, ...patch, current: installation(root)!.active.version, channel: installation(root)!.channel };
    atomicJson(join(root, "status.json"), status);
  };
  /** One line in the service's log, with the time: what shahi.logs shows. */
  const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
  async function stop() {
    const old = child; child = undefined;
    if (!running(old)) return;
    old!.kill("SIGTERM");
    await Promise.race([old!.exited, Bun.sleep(5_000)]);
    if (running(old)) { old!.kill("SIGKILL"); await old!.exited; }
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
    closing = true; void stop().finally(() => process.exit(0));
  });

  // Fail closed when herdr no longer has the plugin (registration.ts says
  // why): the service stops, and its unit or plist goes, so nothing starts it
  // again. The passcode, paired devices and data stay on disk, as they do
  // after the shahi.uninstall action. A service installed outside the plugin
  // (no SHAHI_ENV_FILE, as in the smoke tests) is never "removed".
  const registered = () => registration({
    herdr: herdrBinary(),
    pluginId: process.env.SHAHI_PLUGIN_ID || "shahi",
    configDir: process.env.SHAHI_ENV_FILE ? dirname(process.env.SHAHI_ENV_FILE) : "",
  });
  async function retireIfRemoved() {
    if (!await confirmedRemoved(registered)) return;
    closing = true;
    log(removalNotice(process.env.HERDR_SOCKET_PATH));
    await stop();
    try { serviceFor(process.platform, homedir(), process.getuid?.() ?? 0).remove(); }
    catch (e) { console.error(`Could not remove Shahi's service: ${message(e)}`); }
    // Removal stops this process; if it could not, the OS restarts it and
    // this check runs again before the service does.
    process.exit(0);
  }
  await retireIfRemoved();
  let nextRegistrationCheck = Date.now() + REGISTRATION_CHECK_MS;
  /** Waits, still asking herdr whether the plugin is installed. */
  async function pause(ms: number) {
    const until = Date.now() + ms;
    while (!closing && Date.now() < until) {
      if (Date.now() >= nextRegistrationCheck) {
        nextRegistrationCheck = Date.now() + REGISTRATION_CHECK_MS;
        await retireIfRemoved();
      }
      await Bun.sleep(Math.max(0, Math.min(1_000, until - Date.now())));
    }
  }

  // The service reads the same configuration and would fail on the same
  // line, so there is nothing to start until it loads. A manager that threw
  // here (a bad SHAHI_ALLOWED_HOSTS, a PORT that is not a port) was restarted
  // by the OS every 3 s, each time with Bun's minified source around the
  // message (pre-release bug hunt). The file is read again on each attempt,
  // so a fix is picked up without a restart.
  let config: Config | undefined;
  for (let failures = 1; !config && !closing; failures++) {
    try { config = loadConfig(); }
    catch (e) {
      const delay = respawnDelay(failures);
      const why = `Shahi cannot start: ${message(e)}${process.env.SHAHI_ENV_FILE ? ` Fix it in ${process.env.SHAHI_ENV_FILE}.` : ""}`;
      log(`${why} Trying again in ${seconds(delay)}.`);
      save({ phase: "failed", message: why });
      await pause(delay);
    }
  }
  if (!config) return;
  const client = new HerdrClient({ socketPath: config.socketPath });
  const auth = new Auth({ passcodeHash: "", sessionSecret: config.sessionSecret, sessionTtlMs: 60_000 });
  const base = `http://${config.host}:${config.port}`;

  // A service that exits by itself is started again later each time it keeps
  // doing so; while it is down, `respawnAt` is when, and the status says why.
  let failures = 0;
  let respawnAt = 0;
  const runner: Runner = {
    async activate(release) {
      await stop();
      if (closing) throw new Error("Manager is shutting down.");
      startedAt = Date.now();
      respawnAt = 0;
      const dir = releaseDirectory(root, release);
      if (!existsSync(join(dir, "verified.json"))) throw new Error("Release has not been verified.");
      child = Bun.spawn([process.execPath, join(dir, "service.js")], {
        cwd: dir, env: { ...process.env, SHAHI_MANAGER_ROOT: root, WEB_ROOT: join(dir, "web") },
        stdout: "inherit", stderr: "inherit", stdin: "ignore",
        ipc: () => {},
      });
    },
    async ready(release, serverId) {
      const until = Date.now() + 30_000;
      while (Date.now() < until && !closing && running(child)) {
        try {
          const res = await fetch(`${base}/api/control/handshake`, { headers: { cookie: auth.cookie(auth.issue()).split(";")[0]!, "x-shahi-control": "1" }, signal: AbortSignal.timeout(2_000) });
          if (res.ok) {
            const h = await res.json() as ControlHandshake;
            // Recovery readiness is intentional: an offline herdr must not
            // prevent repairing Shahi. Backend compatibility is checked first.
            if (h.control === 1 && h.buildId === release.buildId && (!serverId || h.serverId === serverId)) {
              let needsBackend = false;
              try { const pong = await client.rpc("ping", {}); needsBackend = release.herdr.some(p => p.version === pong.version && p.protocol === pong.protocol); } catch { /* Recovery-only readiness while herdr is offline. */ }
              if (needsBackend && h.backend.state !== "connected") { await Bun.sleep(250); continue; }
              const web = await fetch(base, { signal: AbortSignal.timeout(2_000) });
              if (web.ok && (await web.text()).includes('id="root"')) return true;
            }
          }
        } catch { /* The child is starting. */ }
        await Bun.sleep(250);
      }
      return false;
    },
    phase(phase, message) { save({ phase, message, ...(phase === "ready" ? { available: undefined } : {}) }); },
  };
  const down = () => !running(child);
  /** The service stopped by itself, or could not be started: one line, a status, and a later start. */
  function exited(cause?: string) {
    if (closing) return;
    const ran = Date.now() - startedAt;
    failures = ran >= HEALTHY_RUN_MS ? 1 : failures + 1;
    const delay = respawnDelay(failures);
    respawnAt = Date.now() + delay;
    const why = cause !== undefined || !child
      ? `Shahi's service could not be started${cause ? `: ${cause}` : "."}`
      : `Shahi's service ${child.signalCode ? `was stopped by ${child.signalCode}` : `exited with code ${child.exitCode}`}${ran < HEALTHY_RUN_MS ? `, ${seconds(ran)} after it started` : ""}.`;
    log(`${why} Starting it again in ${seconds(delay)}.`);
    save({ phase: "failed", message: why });
  }
  const managerChanges = (release: Release) => sha256(readFileSync(join(releaseDirectory(root, release), "manager.js"))) !== managerHash;
  /**
   * What follows a committed activation, wherever it finished: only the
   * active and previous releases are kept, and a manager the active release
   * brings replaces this one, which exits for the OS to start it. This ran
   * only after an update the manager itself carried through, so one whose
   * manager was stopped mid-activation (a logout, a SIGKILL) and finished at
   * the next start kept the old manager and a leftover release until herdr's
   * next start (compatibility bug hunt).
   */
  async function reconcile() {
    const record = installation(root)!;
    for (const dir of readdirSync(join(root, "releases"))) {
      if (dir !== record.active.buildId && dir !== record.previous?.buildId) rmSync(join(root, "releases", dir), { recursive: true, force: true });
    }
    if (!managerChanges(record.active)) return;
    await Bun.write(join(root, "manager.next.js"), readFileSync(join(releaseDirectory(root, record.active), "manager.js")));
    renameSync(join(root, "manager.next.js"), join(root, "manager.js"));
    // The OS restarts the approved supervisor with the same state. The
    // activation journal is already committed before this point, and the
    // status still says "restarting" for the new manager to finish.
    closing = true; await stop(); process.exit(0);
  }

  // An update that brings a new manager is not ready when its service is:
  // that service stops with this manager a moment later. So "restarting"
  // stays up until the new manager has started it again and says "ready",
  // where it used to say "ready" and then drop the phone's link once more
  // (compatibility bug hunt).
  const activateUpdate = async (release: Release, serverId?: string) => beginTransaction(root, release, runner, serverId, { handoff: managerChanges(release) });

  let nextCheck = 0;
  try {
    const pending = readJson<{ target: Release }>(join(root, "transaction.json"));
    if (pending) {
      await finishTransaction(root, runner, { handoff: managerChanges(pending.target) });
      await reconcile();
      // Its outcome — ready, or rolled back with the reason — stays up as it
      // does after an update this manager ran, rather than being cleared by a
      // catalog check a millisecond later, which offered the release that
      // had just failed (compatibility bug hunt).
      nextCheck = Date.now() + CATALOG_CHECK_MS;
    } else {
      // Before the service starts, so a manager that must be replaced does
      // not start it only to stop it again.
      await reconcile();
      const release = installation(root)!.active;
      await runner.activate(release);
      if (await runner.ready(release)) {
        if (handedOver) { runner.phase("ready"); nextCheck = Date.now() + CATALOG_CHECK_MS; }
        else save({ phase: "idle" });
      } else if (!down()) save({ phase: "failed", message: "The installed service did not become ready. Its recovery files are retained." });
    }
  } catch (e) {
    // The status already says what failed; the log gets one line instead of
    // an uncaught throw's minified source. The loop below keeps starting the
    // active release, and the next manager start retries a pending journal.
    log(`Shahi's manager could not finish starting: ${message(e)}`);
  }

  async function check(channel = installation(root)!.channel): Promise<{ catalog: Catalog; release: Release | null }> {
    // While the service is down, its failure is what the status says.
    if (!down()) save({ phase: "checking", message: undefined });
    const record = installation(root)!;
    const raw = Buffer.from(await download(CATALOG_URL(channel), 256 * 1024)).toString("utf8");
    const catalog = verifyCatalog(raw, channel, record.sequence[channel] ?? 0);
    let herdr = null; try { herdr = await client.rpc("ping", {}); } catch { /* Recovery works offline. */ }
    const result = selectRelease(catalog, { platform: `${process.platform}-${process.arch}`, bun: Bun.version, herdr, current: record.active });
    atomicJson(join(root, `catalog-${channel}.json`), JSON.parse(raw));
    atomicJson(join(root, "installation.json"), { ...record, channel, sequence: { ...record.sequence, [channel]: catalog.sequence } });
    const available = result.release?.buildId !== record.active.buildId ? result.release?.version : undefined;
    save(down() ? { available, checkedAt: Date.now() } : { phase: available ? "available" : "idle", available, checkedAt: Date.now(), message: result.reason });
    return { catalog, release: result.release };
  }
  while (!closing) {
    try {
      if (Date.now() >= nextRegistrationCheck) {
        nextRegistrationCheck = Date.now() + REGISTRATION_CHECK_MS;
        await retireIfRemoved();
      }
      if (down()) {
        if (!respawnAt) exited();
        else if (Date.now() >= respawnAt) {
          const release = installation(root)!.active;
          let started = false;
          try { await runner.activate(release); started = true; } catch (e) { exited(message(e)); }
          if (started && await runner.ready(release) && status.phase === "failed") save({ phase: status.available ? "available" : "idle", message: undefined });
        }
      }
      const requestPath = join(root, "request.json");
      const request = readJson<UpdateRequest>(requestPath);
      if (request) rmSync(requestPath);
      if (request && (request.action !== "check" && request.action !== "install" || request.channel !== undefined && !["stable", "beta"].includes(request.channel))) throw new Error("Invalid manager request.");
      if (request || Date.now() >= nextCheck) {
        nextCheck = Date.now() + CATALOG_CHECK_MS;
        const { release } = await check(request?.channel);
        if (request?.action === "install" && release && release.buildId !== installation(root)!.active.buildId) {
          save({ phase: "downloading", message: undefined });
          await stage(root, release, async (url, size) => {
            const bytes = await download(url, size); save({ phase: "verifying" }); return bytes;
          });
          let serverId: string | undefined;
          try { const response = await fetch(`${base}/api/meta`, { signal: AbortSignal.timeout(2_000) }); serverId = (await response.json() as { serverId: string }).serverId; } catch { /* Service may already be down. */ }
          await activateUpdate(release, serverId);
          if (!readJson(join(root, "transaction.json"))) await reconcile();
        }
      }
    } catch (e) { if (!closing) save({ phase: "failed", message: e instanceof Error ? e.message : "The update could not complete. Your installed release is retained." }); }
    await Bun.sleep(1_000);
  }
}

if (import.meta.main) {
  const root = process.env.SHAHI_MANAGER_ROOT;
  if (!root || !installation(root)) throw new Error("No managed Shahi installation.");
  await manage(root);
}
