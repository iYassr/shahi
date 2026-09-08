/** Runs real old/new sidecars against a recording socket, never a user's herdr. */
import { mkdtempSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import { Auth } from "../../server/lib/auth";
import { stage } from "./stage";
import type { Release } from "./catalog";
import type { ControlHandshake } from "@shahi/shared";

const root = resolve(import.meta.dir, "../..");
const scratch = mkdtempSync(join(tmpdir(), "shahi-contracts-"));
const socketPath = join(scratch, "recording-herdr.sock");
let backend = "0.9.0";
const writes: string[] = [];
const stub = createServer(socket => {
  let buffer = "";
  socket.on("data", bytes => {
    buffer += bytes.toString();
    const at = buffer.indexOf("\n"); if (at < 0) return;
    const message = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
    const { id, method } = message;
    const protocol = backend === "0.9.0" ? 22 : 23;
    const result = method === "ping" ? { version: backend, protocol }
      : method === "session.snapshot" ? { snapshot: { version: backend, protocol, workspaces: [], tabs: [], panes: [], agents: [], layouts: [], focused_pane_id: null } }
      : null;
    if (method === "events.subscribe") { socket.write(JSON.stringify({ id, result: { subscribed: true } }) + "\n"); return; }
    if (!result) { writes.push(method); socket.end(JSON.stringify({ id, error: { code: "test_refused", message: "Recording stub refuses writes" } }) + "\n"); }
    else socket.end(JSON.stringify({ id, result }) + "\n");
  });
});
await new Promise<void>(resolve => stub.listen(socketPath, resolve));
const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = listener.port; listener.stop(true);
const base = `http://127.0.0.1:${port}`;
let child: ReturnType<typeof Bun.spawn> | undefined;
const env = { ...process.env, SHAHI_ENV_FILE: "", PASSCODE_HASH_B64: Buffer.from(await Auth.hashPasscode("2468")).toString("base64"), SESSION_SECRET: crypto.randomUUID(), HERDR_SOCKET_PATH: socketPath, SHAHI_DATA: join(scratch, "state/shahi.sqlite"), PORT: String(port), RELAY_URL: "", WEB_ROOT: join(root, "web/dist"), SHAHI_MANAGER_ROOT: "" };
const auth = new Auth({ passcodeHash: "", sessionSecret: env.SESSION_SECRET, sessionTtlMs: 60_000 });
const owner = auth.cookie(auth.issue()).split(";")[0]!;
async function get(path: string, cookie = owner, api = "5") { return fetch(base + path, { headers: { cookie, "x-shahi-api": api, "x-shahi-control": "1" }, signal: AbortSignal.timeout(1_000) }); }
async function stop() {
  if (!child) return; child.kill("SIGTERM"); await child.exited; child = undefined;
}
async function start(entry: string, web = join(root, "web/dist")) {
  await stop();
  child = Bun.spawn([process.execPath, entry], { cwd: root, env: { ...env, WEB_ROOT: web }, stdout: Bun.file(join(scratch, "service.log")), stderr: Bun.file(join(scratch, "service.log")) });
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`Test service exited (${child.exitCode}).`);
    try { if ((await get("/api/session")).ok) return; } catch { /* Starting */ }
    await Bun.sleep(100);
  }
  throw new Error("Test service did not become ready.");
}
try {
  // A pinned shipped client/service baseline. No floating master reference.
  const previous = join(scratch, "previous"); mkdirSync(previous);
  const archive = Bun.spawnSync(["git", "archive", "393e012fc8bf3ec100cddb342f61a6dd8b2db9f2"], { cwd: root });
  assert.equal(archive.exitCode, 0, "Fetch the supported baseline before the release matrix.");
  const extracted = Bun.spawnSync(["tar", "-x", "-C", previous], { stdin: archive.stdout }); assert.equal(extracted.exitCode, 0);
  symlinkSync(join(root, "node_modules"), join(previous, "node_modules"));
  // The workspace symlink points at current shared; API 5 is deliberately the
  // same baseline. The server's route implementation itself comes from the pin.
  await start(join(previous, "server/index.ts"));
  const before = await (await get("/api/meta")).json() as { serverId: string };
  const minted = await (await fetch(base + "/api/pair", { method: "POST", headers: { cookie: owner } })).json() as { secret: string };
  const claim = await fetch(base + "/api/pair/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: minted.secret, deviceName: "Upgrade test phone" }) });
  assert.equal(claim.status, 200);
  const paired = claim.headers.get("set-cookie")!.split(";")[0]!;
  assert.equal((await get("/api/control/handshake", paired)).status, 404, "New app recognizes the unmanaged baseline without re-pairing.");
  assert.equal((await get("/api/session", paired)).status, 200);
  const release = await Bun.file(join(root, "dist/release/release.json")).json() as Release;
  const dir = await stage(join(scratch, "managed"), release, async () => Bun.file(join(root, "dist/release/shahi-service.tar.gz")).bytes());
  await start(join(dir, "service.js"), join(dir, "web"));
  assert.equal((await (await get("/api/meta")).json() as { serverId: string }).serverId, before.serverId);
  for (const api of ["5", "5"]) assert.equal((await get("/api/session", paired, api)).status, 200, "Both shipped and new apps retain their contract and pairing.");
  const handshake = await (await get("/api/control/handshake", paired, "99")).json() as ControlHandshake;
  assert.equal(handshake.buildId, release.buildId); assert.equal(handshake.backend.state, "connected");
  assert.equal((await get("/api/session", paired, "4")).status, 426, "Unsafe old API remains refused.");
  assert.equal((await get("/api/session", paired, "99")).status, 426);
  const html = await (await fetch(base)).text(); assert.ok(html.includes('id="root"'));
  for (const asset of html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)) { const res = await fetch(base + asset[1]); assert.ok(res.ok && (await res.arrayBuffer()).byteLength > 0, "Packaged assets must contain their actual bytes."); }
  backend = "0.10.0"; await Bun.sleep(3_500);
  const recovery = await (await get("/api/control/handshake", paired)).json() as ControlHandshake;
  assert.equal(recovery.backend.state, "service-update-required"); assert.equal((await get("/api/session", paired)).status, 503);
  assert.equal((await get("/api/devices", paired)).status, 200);
  backend = "0.9.0"; await Bun.sleep(3_500); assert.equal((await get("/api/session", paired)).status, 200);
  await start(join(previous, "server/index.ts"));
  assert.equal((await get("/api/session", paired)).status, 200, "Rollback preserves existing device sessions.");
  assert.equal((await (await get("/api/meta")).json() as { serverId: string }).serverId, before.serverId);
  assert.deepEqual(writes, [], "No write may leave the recording fixture.");
  console.log("Passed: shipped/current API, verified package assets, preserved identity and pairing, unsupported herdr recovery, reconnect, and rollback.");
} finally { await stop(); stub.close(); rmSync(scratch, { recursive: true, force: true }); }
