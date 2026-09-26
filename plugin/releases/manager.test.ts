/**
 * The manager run for real, the way a release runs it: bundled into
 * `<root>/manager.js`, supervising fake services on a spare loopback port,
 * with a test signing key and GitHub answered from files, so nothing leaves
 * this machine and no real Shahi, herdr or service manager is touched. The
 * test plays the OS: when the manager exits to be replaced, it starts it again.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComputerUpdate } from "@shahi/shared";
import { Auth } from "../../server/lib/auth";
import { sha256, type Release } from "./catalog";
import { HEALTHY_RUN_MS, respawnDelay } from "./manager";
import { atomicJson, installation, readJson, requestUpdate } from "./storage";

const scratches: string[] = [];
afterAll(() => { for (const dir of scratches) rmSync(dir, { recursive: true, force: true }); });

const key = generateKeyPairSync("ed25519");
let managerBytes = new Uint8Array();
/** Another manager: what an update that also changes the manager ships. */
let nextManagerBytes = new Uint8Array();
let passcodeHash = "";
beforeAll(async () => {
  const publicKey = key.publicKey.export({ type: "spki", format: "pem" }).toString();
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "manager.ts")], target: "bun", minify: true,
    plugins: [{ name: "test-release-key", setup(build) {
      build.onLoad({ filter: /releases\/trust\.ts$/ }, () => ({ contents: `export const RELEASE_KEYS = ${JSON.stringify({ test: publicKey })};`, loader: "ts" }));
    } }],
  });
  if (!built.success) throw new Error(built.logs.join("\n"));
  managerBytes = new Uint8Array(await built.outputs[0]!.arrayBuffer());
  nextManagerBytes = new Uint8Array([...managerBytes, ...new TextEncoder().encode("\n// the next manager\n")]);
  passcodeHash = Buffer.from(await Auth.hashPasscode("2468")).toString("base64");
}, 60_000);

const managers: ReturnType<typeof Bun.spawn>[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) if (m.exitCode === null) { m.kill("SIGTERM"); await Promise.race([m.exited, Bun.sleep(8_000)]); m.kill("SIGKILL"); }
});

function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

const platform = `${process.platform}-${process.arch}`;
function release(version: string, buildId: string): Release {
  return {
    version, buildId, commit: "a".repeat(40),
    artifact: { url: `https://github.com/iYassr/shahi/releases/download/v${version}/shahi-service.tar.gz`, sha256: "0".repeat(64), bytes: 1 },
    platforms: [platform], bun: "1.0.0", api: { min: 5, max: 5 }, transport: 2, control: 1, manager: 1, dataSchema: 1,
    herdr: [{ version: "0.9.1", protocol: 22 }],
  };
}

/**
 * A service: it notes each start, then either serves what the manager's
 * readiness check asks for, or fails at once the way a sidecar whose port is
 * taken does, in one line.
 */
function service(buildId: string, starts: string, works: boolean): string {
  const note = `require("node:fs").appendFileSync(${JSON.stringify(starts)}, ${JSON.stringify(buildId)} + " " + process.pid + " " + Date.now() + "\\n");`;
  if (!works) return `${note}\nconsole.error(new Date().toISOString() + " Shahi could not start: Failed to start server. Is port " + process.env.PORT + " in use?");\nprocess.exit(1);\n`;
  return `${note}
Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), reusePort: false, fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === "/api/control/handshake") return Response.json({ control: 1, serverId: "test-server", buildId: ${JSON.stringify(buildId)}, backend: { state: "offline", message: "herdr is offline" } });
  if (path === "/api/meta") return Response.json({ serverId: "test-server" });
  return new Response('<div id="root"></div>');
} });
if (process.connected) process.on("disconnect", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
`;
}

interface Built { release: Release; files: Record<string, Uint8Array | string> }

async function computer() {
  const dir = mkdtempSync(join(tmpdir(), "shahi-manager-"));
  scratches.push(dir);
  const root = join(dir, "managed"), starts = join(dir, "starts.log"), logPath = join(dir, "shahi.log");
  mkdirSync(join(root, "releases"), { recursive: true });
  const port = freePort();
  const artifacts: Record<string, string> = {};
  let sequence = 0;

  const build = (version: string, buildId: string, { works = true, manager = managerBytes } = {}): Built => ({
    release: release(version, buildId),
    files: { "service.js": service(buildId, starts, works), "manager.js": manager, "web/index.html": '<div id="root"></div>' },
  });
  /** On disk and verified, as stage() leaves it. */
  function staged(b: Built) {
    const at = join(root, "releases", b.release.buildId);
    for (const [path, bytes] of Object.entries(b.files)) { mkdirSync(join(at, path, ".."), { recursive: true }); writeFileSync(join(at, path), bytes); }
    writeFileSync(join(at, "verified.json"), JSON.stringify(b.release));
    return b.release;
  }
  /** Downloadable from "GitHub", as a signed release with its archive. */
  async function published(b: Built): Promise<Release> {
    const bytes = new Uint8Array(await new Bun.Archive(b.files, { compress: "gzip" }).bytes());
    const path = join(dir, `${b.release.buildId}.tar.gz`);
    writeFileSync(path, bytes);
    const r = { ...b.release, artifact: { ...b.release.artifact, bytes: bytes.length, sha256: sha256(bytes) } };
    artifacts[r.artifact.url] = path;
    return r;
  }
  function catalog(releases: Release[]) {
    const payload = Buffer.from(JSON.stringify({ schema: 1, channel: "stable", sequence: ++sequence, publishedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), releases }));
    const catalogPath = join(dir, "catalog.json");
    atomicJson(catalogPath, { keyId: "test", payload: payload.toString("base64"), signature: sign(null, payload, key.privateKey).toString("base64") });
    atomicJson(join(dir, "feed.json"), { catalogPath, artifacts });
  }
  const preload = join(dir, "feed.js");
  writeFileSync(preload, `const realFetch = globalThis.fetch; globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("https://")) return realFetch(input, init);
  const feed = await Bun.file(${JSON.stringify(join(dir, "feed.json"))}).json().catch(() => ({ artifacts: {} }));
  const path = url.endsWith("/catalog.json") ? feed.catalogPath : feed.artifacts[url];
  return path ? new Response(Bun.file(path)) : new Response(null, { status: 404 });
};`);
  writeFileSync(join(root, "manager.js"), managerBytes);

  const env = (extra: Record<string, string>) => ({
    PATH: process.env.PATH ?? "", HOME: dir, SHAHI_ENV_FILE: "", SHAHI_MANAGER_ROOT: root,
    PASSCODE_HASH_B64: passcodeHash, SESSION_SECRET: "k".repeat(43), HERDR_SOCKET_PATH: join(dir, "no-herdr.sock"),
    SHAHI_DATA: join(dir, "shahi.sqlite"), PORT: String(port), RELAY_URL: "", ...extra,
  });
  /** Starts the manager in root, as launchd or systemd would: output appended to the log. */
  function start(extra: Record<string, string> = {}) {
    const log = openSync(logPath, "a");
    const manager = Bun.spawn([process.execPath, "--preload", preload, join(root, "manager.js")], {
      cwd: dir, env: env(extra), stdout: log, stderr: log,
    });
    closeSync(log);
    managers.push(manager);
    return manager;
  }
  const status = () => readJson<ComputerUpdate>(join(root, "status.json"));
  const startsOf = () => existsSync(starts) ? readFileSync(starts, "utf8").trim().split("\n").map((l) => { const [id, pid, at] = l.split(" "); return { id: id!, pid: Number(pid), at: Number(at) }; }) : [];
  const log = () => existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  async function until(ok: () => boolean, ms = 20_000, what = "") {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (ok()) return; await Bun.sleep(50); }
    throw new Error(`Timed out${what ? ` waiting for ${what}` : ""}: status ${JSON.stringify(status())}\n${log()}`);
  }
  return { dir, root, port, build, staged, published, catalog, start, status, starts: startsOf, log, until };
}

describe("how long a failing service waits to be started again", () => {
  test("3 s, then doubling, to at most five minutes", () => {
    expect([1, 2, 3, 4, 5].map(respawnDelay)).toEqual([3_000, 6_000, 12_000, 24_000, 48_000]);
    expect(respawnDelay(8)).toBe(300_000);
    expect(respawnDelay(40)).toBe(300_000);
    expect(HEALTHY_RUN_MS).toBe(60_000);
  });
});

/**
 * With the port taken, the manager started the sidecar every ~4 s forever,
 * and each crash wrote ~5.5 KB of minified source to the unrotated log: 44 KB
 * in 30 s, about 127 MB a day. The catalog check then set the status to idle
 * while it crash-looped, so nothing said why (pre-release bug hunt).
 */
describe("a service that fails at every start", () => {
  test("is started again after 3 s, then 6 s, with one short line each time, and the status says why", async () => {
    const c = await computer();
    const active = c.staged(c.build("0.3.7", "failing-build", { works: false }));
    atomicJson(join(c.root, "installation.json"), { active, channel: "stable", sequence: {} });
    c.catalog([active]);
    c.start();
    await c.until(() => c.log().includes("Starting it again in 12 s."), 25_000, "the third failure");
    const at = c.starts().map((s) => s.at);
    expect(at).toHaveLength(3);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(2_900);
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(5_900);
    // A catalog check while it waits leaves the failure in place.
    const checked = c.status()?.checkedAt ?? 0;
    requestUpdate(c.root, { action: "check" });
    await c.until(() => (c.status()?.checkedAt ?? 0) > checked, 5_000, "the catalog check");
    expect(c.status()).toMatchObject({ phase: "failed", message: expect.stringMatching(/^Shahi's service exited with code 1, [\d.]+ s after it started\.$/) });
    const lines = c.log().trim().split("\n");
    expect(lines.every((line) => line.length < 300)).toBe(true);
    expect(lines.filter((line) => line.includes("Starting it again in")).length).toBe(3);
    expect(c.log()).toContain("Starting it again in 12 s.");
    expect(c.log().length).toBeLessThan(2_000);
  }, 40_000);

  test("a service killed by a signal is started again, and the status clears once it answers", async () => {
    const c = await computer();
    const active = c.staged(c.build("0.3.7", "working-build"));
    atomicJson(join(c.root, "installation.json"), { active, channel: "stable", sequence: {} });
    c.catalog([active]);
    c.start();
    await c.until(() => c.status()?.phase === "idle" && !!c.status()?.checkedAt, 20_000, "idle");
    // What the OOM killer does. Bun leaves exitCode null for it, and a
    // manager that looked only at exitCode never noticed.
    process.kill(c.starts()[0]!.pid, "SIGKILL");
    await c.until(() => c.starts().length === 2, 10_000, "a second start");
    expect(c.log()).toContain("Shahi's service was stopped by SIGKILL");
    await c.until(() => c.status()?.phase === "idle", 10_000, "idle again");
    expect(c.status()?.message).toBeUndefined();
  }, 40_000);

  test("a manager whose configuration does not load waits instead of exiting, and says why in one line", async () => {
    const c = await computer();
    const active = c.staged(c.build("0.3.7", "working-build"));
    atomicJson(join(c.root, "installation.json"), { active, channel: "stable", sequence: {} });
    const manager = c.start({ SHAHI_ALLOWED_HOSTS: "http://not a host" });
    await c.until(() => c.status()?.phase === "failed", 10_000, "the failure");
    await Bun.sleep(4_000);
    expect(manager.exitCode).toBeNull();
    expect(c.starts()).toEqual([]);
    expect(c.status()?.message).toContain("SHAHI_ALLOWED_HOSTS");
    const lines = c.log().trim().split("\n");
    expect(lines).toHaveLength(2); // at 0 s and 3 s; the next is at 9 s
    expect(lines.every((line) => line.length < 300 && line.includes("Trying again in"))).toBe(true);
  }, 30_000);
});

/**
 * An update whose manager was stopped mid-activation (a logout's SIGTERM, a
 * SIGKILL) was finished at the next start without what follows it: the
 * manager kept its old self and a leftover release until herdr restarted; a
 * failed one lost its "rolled-back" within milliseconds to a catalog check
 * that offered the same broken build, with previous equal to active and the
 * broken release left on disk (compatibility bug hunt). These start the
 * manager on exactly what such a stop leaves.
 */
describe("an update interrupted mid-activation", () => {
  test("that fails is rolled back with its notice kept, previous restored and the failed release removed", async () => {
    const c = await computer();
    const older = c.staged(c.build("0.3.5", "older-build"));
    const current = c.staged(c.build("0.3.6", "current-build"));
    const broken = c.staged(c.build("0.3.7", "broken-build", { works: false }));
    c.catalog([broken, current, older]);
    atomicJson(join(c.root, "transaction.json"), { previous: current, target: broken, serverId: "test-server", earlier: older });
    // Written by the first attempt before it was stopped.
    atomicJson(join(c.root, "installation.json"), { active: broken, previous: current, channel: "stable", sequence: {} });
    atomicJson(join(c.root, "status.json"), { managed: true, phase: "restarting", channel: "stable", current: "0.3.7" });
    c.start();
    await c.until(() => c.status()?.phase === "rolled-back", 30_000, "the rollback");
    await Bun.sleep(3_000);
    expect(c.status()).toMatchObject({ phase: "rolled-back", message: expect.stringContaining("previous release") });
    expect(c.status()?.checkedAt).toBeUndefined();
    const record = installation(c.root)!;
    expect(record.active.buildId).toBe("current-build");
    expect(record.previous?.buildId).toBe("older-build");
    expect(readdirSync(join(c.root, "releases")).sort()).toEqual(["current-build", "older-build"]);
    expect(existsSync(join(c.root, "transaction.json"))).toBe(false);
  }, 60_000);

  test("that brings a new manager hands over to it, and only the new one says ready", async () => {
    const c = await computer();
    const current = c.staged(c.build("0.3.6", "current-build"));
    const target = c.staged(c.build("0.3.7", "target-build", { manager: nextManagerBytes }));
    mkdirSync(join(c.root, "releases", "leftover-build"));
    c.catalog([target, current]);
    atomicJson(join(c.root, "transaction.json"), { previous: current, target, serverId: "test-server", earlier: null });
    atomicJson(join(c.root, "installation.json"), { active: target, previous: current, channel: "stable", sequence: {} });
    atomicJson(join(c.root, "status.json"), { managed: true, phase: "restarting", channel: "stable", current: "0.3.7" });
    const first = c.start();
    // It finishes the activation, replaces itself and exits for the OS.
    expect(await Promise.race([first.exited, Bun.sleep(30_000).then(() => "still running")])).toBe(0);
    expect(sha256(readFileSync(join(c.root, "manager.js")))).toBe(sha256(nextManagerBytes));
    expect(c.status()?.phase).toBe("restarting");
    expect(readdirSync(join(c.root, "releases")).sort()).toEqual(["current-build", "target-build"]);
    c.start();
    await c.until(() => c.status()?.phase === "ready", 20_000, "ready from the new manager");
    expect(c.starts().map((s) => s.id)).toEqual(["target-build", "target-build"]);
  }, 60_000);
});

/**
 * An update that also replaced the manager reported "ready", then the manager
 * replaced itself, stopped the service it had just declared ready and exited;
 * the phone lost its link again while believing the update had finished
 * (compatibility bug hunt).
 */
test("an update that brings a new manager says restarting until the new manager's service is up", async () => {
  const c = await computer();
  const current = c.staged(c.build("0.3.6", "current-build"));
  atomicJson(join(c.root, "installation.json"), { active: current, channel: "stable", sequence: {} });
  const next = await c.published(c.build("0.3.7", "next-build", { manager: nextManagerBytes }));
  c.catalog([current]);
  const first = c.start();
  await c.until(() => c.status()?.phase === "idle" && !!c.status()?.checkedAt, 20_000, "idle");
  c.catalog([next, current]);
  requestUpdate(c.root, { action: "install" });
  expect(await Promise.race([first.exited, Bun.sleep(40_000).then(() => "still running")])).toBe(0);
  // What the phone reads between the old manager's exit and the new one's start.
  expect(c.status()?.phase).toBe("restarting");
  expect(installation(c.root)?.active.buildId).toBe("next-build");
  c.start();
  await c.until(() => c.status()?.phase === "ready", 20_000, "ready");
  expect(sha256(readFileSync(join(c.root, "manager.js")))).toBe(sha256(nextManagerBytes));
}, 90_000);
