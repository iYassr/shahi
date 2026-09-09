/** Actual supervisor/download/restart loop, with a test-only signing root and feed. */
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { Auth } from "../../server/lib/auth";
import { sha256, type Release } from "./catalog";
import { atomicJson, installation, updateStatus } from "./storage";
import { stage } from "./stage";

const repo = resolve(import.meta.dir, "../..");
const scratch = mkdtempSync(join(tmpdir(), "shahi-manager-test-"));
const root = join(scratch, "managed");
const key = generateKeyPairSync("ed25519");
const publicKey = key.publicKey.export({ type: "spki", format: "pem" }).toString();
const managerBuild = await Bun.build({ entrypoints: [join(repo, "plugin/releases/manager.ts")], target: "bun", minify: true, plugins: [{ name: "isolated-release-key", setup(build) {
  build.onLoad({ filter: /releases\/trust\.ts$/ }, () => ({ contents: `export const RELEASE_KEYS = ${JSON.stringify({ test: publicKey })};`, loader: "ts" }));
} }] });
assert.ok(managerBuild.success);
const managerBytes = new Uint8Array(await managerBuild.outputs[0]!.arrayBuffer());
const artifactFiles = await new Bun.Archive(await Bun.file(join(repo, "dist/release/shahi-service.tar.gz")).bytes()).files();
const baseFiles: Record<string, Uint8Array> = {};
for (const [path, file] of artifactFiles) baseFiles[path] = new Uint8Array(await file.arrayBuffer());
baseFiles["manager.js"] = managerBytes;
const definition = await Bun.file(join(repo, "dist/release/release.json")).json() as Release;
const artifacts: Record<string, string> = {};
async function packageRelease(version: string, buildId: string, service: Uint8Array): Promise<Release> {
  const bytes = new Uint8Array(await new Bun.Archive({ ...baseFiles, "service.js": service }, { compress: "gzip" }).bytes());
  const path = join(scratch, `${buildId}.tar.gz`); await Bun.write(path, bytes);
  const r = { ...definition, version, buildId, artifact: { url: `https://github.com/iYassr/shahi/releases/download/v${version}/shahi-service.tar.gz`, bytes: bytes.length, sha256: sha256(bytes) } };
  artifacts[r.artifact.url] = path; return r;
}
const initial = await packageRelease(definition.version, definition.buildId, baseFiles["service.js"]!);
const [major, minor, patch] = definition.version.split("-")[0]!.split(".").map(Number);
const nextVersion = (offset: number) => `${major}.${minor}.${patch! + offset}`;
const broken = await packageRelease(nextVersion(1), "broken-build", new TextEncoder().encode("process.exit(1);"));
const fixedBuild = await Bun.build({ entrypoints: [join(repo, "server/index.ts")], target: "bun", minify: true, define: { "process.env.SHAHI_BUILD_ID": '"fixed-build"' } });
assert.ok(fixedBuild.success);
const fixed = await packageRelease(nextVersion(2), "fixed-build", new Uint8Array(await fixedBuild.outputs[0]!.arrayBuffer()));
let sequence = 0;
function feed(releases: Release[]) {
  const payload = Buffer.from(JSON.stringify({ schema: 1, channel: "stable", sequence: ++sequence, publishedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400_000).toISOString(), releases }));
  const catalogPath = join(scratch, "catalog.json");
  atomicJson(catalogPath, { keyId: "test", payload: payload.toString("base64"), signature: sign(null, payload, key.privateKey).toString("base64") });
  atomicJson(join(scratch, "feed.json"), { catalogPath, artifacts });
}
feed([initial]);
await stage(root, initial, async () => Bun.file(artifacts[initial.artifact.url]!).bytes());
atomicJson(join(root, "installation.json"), { active: initial, channel: "stable", sequence: {} });
await Bun.write(join(root, "manager.js"), managerBytes);
const preload = join(scratch, "recording-feed.js");
writeFileSync(preload, `const realFetch = globalThis.fetch; globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.startsWith("https://github.com/iYassr/shahi/releases/download/")) {
    const feed = await Bun.file(${JSON.stringify(join(scratch, "feed.json"))}).json();
    const path = url.endsWith("/catalog.json") ? feed.catalogPath : feed.artifacts[url];
    return path ? new Response(Bun.file(path)) : new Response(null, {status:404});
  }
  return realFetch(input, init);
};`);
const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = listener.port; listener.stop(true);
const sessionSecret = crypto.randomUUID();
const env = { ...process.env, SHAHI_ENV_FILE: "", PASSCODE_HASH_B64: Buffer.from(await Auth.hashPasscode("2468")).toString("base64"), SESSION_SECRET: sessionSecret, HERDR_SOCKET_PATH: join(scratch, "missing-recording-herdr.sock"), SHAHI_DATA: join(scratch, "state/shahi.sqlite"), PORT: String(port), RELAY_URL: "", SHAHI_MANAGER_ROOT: root };
const auth = new Auth({ passcodeHash: "", sessionSecret, sessionTtlMs: 60_000 });
const owner = auth.cookie(auth.issue()).split(";")[0]!;
let manager: ReturnType<typeof Bun.spawn> | undefined;
const start = () => { manager = Bun.spawn([process.execPath, "--preload", preload, join(root, "manager.js")], { cwd: scratch, env, stdout: Bun.file(join(scratch, "manager.log")), stderr: Bun.file(join(scratch, "manager.log")) }); };
async function until(ok: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) { if (await ok()) return; if (manager?.exitCode !== null) throw new Error("Fixture manager exited."); await Bun.sleep(100); }
  throw new Error(`Manager test timed out: ${JSON.stringify(updateStatus(root))}`);
}
async function request(path: string, cookie = owner, body?: object) {
  return fetch(`http://127.0.0.1:${port}${path}`, { method: body ? "POST" : "GET", headers: { cookie, "x-shahi-api": "5", "x-shahi-control": "1", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(2_000) });
}
try {
  start(); await until(() => updateStatus(root)?.phase === "idle" && !!updateStatus(root)?.checkedAt);
  const before = await (await request("/api/control/handshake")).json() as { serverId: string };
  const minted = await (await request("/api/pair", owner, {})).json() as { secret: string };
  const paired = await request("/api/pair/claim", owner, { secret: minted.secret, deviceName: "Manager smoke phone" });
  assert.equal(paired.status, 200); const cookie = paired.headers.get("set-cookie")!.split(";")[0]!;
  feed([broken, initial]); assert.equal((await request("/api/control/update", cookie, { action: "install" })).status, 202);
  await until(() => updateStatus(root)?.phase === "rolled-back");
  assert.equal(installation(root)!.active.buildId, initial.buildId); assert.equal((await request("/api/devices", cookie)).status, 200);
  feed([fixed, initial]); assert.equal((await request("/api/control/update", cookie, { action: "install" })).status, 202);
  await until(() => updateStatus(root)?.phase === "ready" && installation(root)!.active.buildId === fixed.buildId);
  assert.equal((await request("/api/devices", cookie)).status, 200);
  // Simulate the OS restarting a supervisor after a crash. The IPC-bound child
  // must release the port instead of surviving as an untracked old process.
  manager!.kill("SIGKILL"); await manager!.exited; start();
  await until(async () => { try { const h = await (await request("/api/control/handshake", cookie)).json() as { serverId: string; buildId: string }; return h.serverId === before.serverId && h.buildId === fixed.buildId && updateStatus(root)?.phase === "idle"; } catch { return false; } });
  assert.equal((await request("/api/devices", cookie)).status, 200);
  console.log("Passed: actual signed download, restart failure rollback, approved update, preserved pairing, and supervisor-crash recovery with herdr offline.");
} finally {
  if (manager?.exitCode === null) { manager.kill("SIGTERM"); await manager.exited; }
  rmSync(scratch, { recursive: true, force: true });
}
