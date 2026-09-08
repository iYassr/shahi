import { existsSync, rmSync, readFileSync, renameSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Auth } from "../../server/lib/auth";
import { loadConfig } from "../../server/lib/config";
import { HerdrClient } from "../../server/lib/herdr-client";
import { type ComputerUpdate, type ControlHandshake } from "@shahi/shared";
import { CATALOG_URL, download, selectRelease, verifyCatalog, sha256, type Catalog, type Release } from "./catalog";
import { atomicJson, installation, readJson, releaseDirectory, type UpdateRequest } from "./storage";
import { stage } from "./stage";
import { beginTransaction, finishTransaction, type Runner } from "./transaction";

export async function manage(root: string) {
  const managerHash = sha256(readFileSync(import.meta.path));
  const config = loadConfig();
  const client = new HerdrClient({ socketPath: config.socketPath });
  const auth = new Auth({ passcodeHash: "", sessionSecret: config.sessionSecret, sessionTtlMs: 60_000 });
  const base = `http://${config.host}:${config.port}`;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let closing = false;
  let status: ComputerUpdate = { managed: true, phase: "idle", channel: installation(root)!.channel, current: installation(root)!.active.version };
  const save = (patch: Partial<ComputerUpdate>) => {
    status = { ...status, ...patch, current: installation(root)!.active.version, channel: installation(root)!.channel };
    atomicJson(join(root, "status.json"), status);
  };
  async function stop() {
    const old = child; child = undefined;
    if (!old || old.exitCode !== null) return;
    old.kill("SIGTERM");
    await Promise.race([old.exited, Bun.sleep(5_000)]);
    if (old.exitCode === null) { old.kill("SIGKILL"); await old.exited; }
  }
  const runner: Runner = {
    async activate(release) {
      await stop();
      if (closing) throw new Error("Manager is shutting down.");
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
      while (Date.now() < until && !closing && child?.exitCode === null) {
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
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
    closing = true; void stop().finally(() => process.exit(0));
  });

  if (readJson(join(root, "transaction.json"))) await finishTransaction(root, runner);
  else {
    const release = installation(root)!.active;
    await runner.activate(release);
    save(await runner.ready(release) ? { phase: "idle" } : { phase: "failed", message: "The installed service did not become ready. Its recovery files are retained." });
  }
  async function check(channel = installation(root)!.channel): Promise<{ catalog: Catalog; release: Release | null }> {
    save({ phase: "checking", message: undefined });
    const record = installation(root)!;
    const raw = Buffer.from(await download(CATALOG_URL(channel), 256 * 1024)).toString("utf8");
    const catalog = verifyCatalog(raw, channel, record.sequence[channel] ?? 0);
    let herdr = null; try { herdr = await client.rpc("ping", {}); } catch { /* Recovery works offline. */ }
    const result = selectRelease(catalog, { platform: `${process.platform}-${process.arch}`, bun: Bun.version, herdr, current: record.active });
    atomicJson(join(root, `catalog-${channel}.json`), JSON.parse(raw));
    atomicJson(join(root, "installation.json"), { ...record, channel, sequence: { ...record.sequence, [channel]: catalog.sequence } });
    const available = result.release?.buildId !== record.active.buildId ? result.release?.version : undefined;
    save({ phase: available ? "available" : "idle", available, checkedAt: Date.now(), message: result.reason });
    return { catalog, release: result.release };
  }
  let nextCheck = 0;
  while (!closing) {
    try {
      if (child?.exitCode !== null) { await Bun.sleep(3_000); await runner.activate(installation(root)!.active); }
      const requestPath = join(root, "request.json");
      const request = readJson<UpdateRequest>(requestPath);
      if (request) rmSync(requestPath);
      if (request && (request.action !== "check" && request.action !== "install" || request.channel !== undefined && !["stable", "beta"].includes(request.channel))) throw new Error("Invalid manager request.");
      if (request || Date.now() >= nextCheck) {
        nextCheck = Date.now() + 6 * 60 * 60_000;
        const { release } = await check(request?.channel);
        if (request?.action === "install" && release && release.buildId !== installation(root)!.active.buildId) {
          save({ phase: "downloading", message: undefined });
          await stage(root, release, async (url, size) => {
            const bytes = await download(url, size); save({ phase: "verifying" }); return bytes;
          });
          let serverId: string | undefined;
          try { const response = await fetch(`${base}/api/meta`, { signal: AbortSignal.timeout(2_000) }); serverId = (await response.json() as { serverId: string }).serverId; } catch { /* Service may already be down. */ }
          await beginTransaction(root, release, runner, serverId);
          const record = installation(root)!;
          if (!readJson(join(root, "transaction.json"))) {
            for (const dir of readdirSync(join(root, "releases"))) {
              if (dir !== record.active.buildId && dir !== record.previous?.buildId) rmSync(join(root, "releases", dir), { recursive: true, force: true });
            }
            const manager = readFileSync(join(releaseDirectory(root, record.active), "manager.js"));
            if (sha256(manager) !== managerHash) {
              await Bun.write(join(root, "manager.next.js"), manager);
              renameSync(join(root, "manager.next.js"), join(root, "manager.js"));
              // The OS restarts the approved supervisor with the same state.
              // The activation journal is already committed before this point.
              closing = true; await stop(); process.exit(0);
            }
          }
        }
      }
    } catch (e) { save({ phase: "failed", message: e instanceof Error ? e.message : "The update could not complete. Your installed release is retained." }); }
    await Bun.sleep(1_000);
  }
}

if (import.meta.main) {
  const root = process.env.SHAHI_MANAGER_ROOT;
  if (!root || !installation(root)) throw new Error("No managed Shahi installation.");
  await manage(root);
}
