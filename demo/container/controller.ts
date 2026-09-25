import { mkdirSync, existsSync } from "node:fs";
import QRCode from "qrcode";
import { startAgentInTab } from "../../server/lib/agents";
import { Auth } from "../../server/lib/auth";
import { HerdrClient } from "../../server/lib/herdr-client";
import { SHAHI_API_VERSION } from "@shahi/shared";
import { pairingUrl } from "../../server/lib/pairing";

const token = process.env.INTERNAL_TOKEN!;
const origin = process.env.DEMO_ORIGIN!;
if (!token || !origin) throw new Error("Demo controller configuration missing");
const data = "/home/demo/.local/share/shahi/shahi.sqlite";
mkdirSync("/run/shahi", { recursive: true, mode: 0o700 });
let ready = false, checkpointAt: string | null = null, checkpointError = false;
let checkpointing: Promise<void> | null = null;
const children: ReturnType<typeof Bun.spawn>[] = [];
const run = async (cmd: string[]) => {
  const p = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  if (await p.exited !== 0) throw new Error("Demo maintenance failed");
};
const stateRequest = (method: string, body?: Uint8Array) => fetch(`${origin}/_state`, {
  method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-length": String(body.byteLength) } : {}) },
  body, signal: AbortSignal.timeout(30_000),
});
async function checkpoint() {
  if (checkpointing) return checkpointing;
  checkpointing = (async () => {
    // Read as the same unprivileged user as the files: a symlink race must
    // never turn the recovery process into a reader of root-only credentials.
    const archive = Bun.spawn(["/usr/sbin/runuser", "-u", "demo", "--", "python3", "/opt/demo/state.py", "save"], { env: userEnv, stdout: "pipe", stderr: "ignore" });
    const bytes = new Uint8Array(await new Response(archive.stdout).arrayBuffer());
    if (await archive.exited !== 0 || bytes.byteLength > 32 * 1024 * 1024) throw new Error("Snapshot failed");
    const result = await stateRequest("PUT", bytes);
    if (!result.ok) throw new Error("Snapshot upload failed");
    checkpointAt = new Date().toISOString(); checkpointError = false;
  })();
  try { await checkpointing; } finally { checkpointing = null; }
}
const userEnv = {
  PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/home/demo", USER: "demo", LOGNAME: "demo", SHELL: "/bin/bash",
  TERM: "xterm-256color", LANG: "C.UTF-8", XDG_CONFIG_HOME: "/home/demo/.config",
  HERDR_SOCKET_PATH: "/home/demo/.config/herdr/sessions/review/herdr.sock",
  HOST: "127.0.0.1", PORT: "7171", SHAHI_DATA: data,
  SESSION_SECRET: process.env.SESSION_SECRET!, PASSCODE_HASH_B64: process.env.PASSCODE_HASH_B64!,
  RELAY_URL: process.env.RELAY_URL!,
};
function launch(args: string[]) {
  const child = Bun.spawn(["/usr/sbin/runuser", "-u", "demo", "--", ...args], {
    cwd: "/home/demo/workspace", env: userEnv, stdout: "ignore", stderr: "ignore", stdin: "ignore",
  });
  children.push(child);
  child.exited.then(() => { if (ready) process.exit(1); });
  return child;
}
const auth = new Auth({ passcodeHash: Buffer.from(userEnv.PASSCODE_HASH_B64, "base64").toString(), sessionSecret: userEnv.SESSION_SECRET, sessionTtlMs: 60_000 });
function local(path: string, method = "GET") {
  return fetch(`http://127.0.0.1:7171${path}`, { method, headers: {
    cookie: auth.cookie(auth.issue()).split(";")[0]!, "x-shahi-api": String(SHAHI_API_VERSION),
  }, signal: AbortSignal.timeout(10_000) });
}
const page = (content: string) => new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shahi review</title><style>body{font:17px/1.6 system-ui;background:#151513;color:#f3eee5;max-width:620px;margin:50px auto;padding:24px}h1{font-size:32px}a{color:#e8b496}button{font:inherit;padding:12px 22px;border:0;border-radius:12px;background:#e8b496;color:#201a15;cursor:pointer}img{display:block;max-width:100%;margin:24px 0}textarea{width:100%;min-height:110px}small{color:#bdb8af}</style><h1>Shahi review computer</h1>${content}<hr><p><a href="https://getshahi.dev/privacy">Privacy policy</a> · <a href="mailto:support@getshahi.dev">Get help</a></p></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });

Bun.serve({ port: 8080, hostname: "0.0.0.0", idleTimeout: 120,
  async fetch(request) {
    if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response("Not found", { status: 404 });
    const path = new URL(request.url).pathname;
    if (path === "/health") return Response.json({ ready, checkpointAt, checkpointError, agents: { codex: "simulated" } }, { status: ready ? 200 : 503 });
    if (!ready) return new Response("The review computer is starting. Refresh in a minute.", { status: 503 });
    if (path === "/checkpoint" && request.method === "POST") { await checkpoint(); return new Response("Saved"); }
    if (path === "/") return page(`<p>This is an isolated computer with a small sample project. You can explore files, use the terminal, and try a Codex client with clearly labeled simulated replies. No AI service or paid API is connected.</p><p>Review activity is stored on this demo computer and in private Cloudflare recovery snapshots. Use sample information only. This environment expires on 31 December 2026.</p><form method="post" action="/pair"><button>Create a pairing code</button></form><p>Open this page on another screen to scan the code, or open the pairing link on your iPhone. Each code works once and expires after ten minutes. Return here whenever you need a fresh code.</p>`);
    if (path === "/pair" && request.method === "POST") {
      const [metaResponse, codeResponse] = await Promise.all([local("/api/meta"), local("/api/pair", "POST")]);
      if (!metaResponse.ok || !codeResponse.ok) return new Response("Pairing is not ready. Please retry.", { status: 503 });
      const meta = await metaResponse.json() as { serverId: string }, code = await codeResponse.json() as { secret: string };
      const url = pairingUrl({ v: 1, server: meta.serverId, relay: userEnv.RELAY_URL, secret: code.secret });
      const image = await QRCode.toDataURL(url, { width: 360, margin: 2 });
      return page(`<p>Scan this code in Shahi or tap the link on your iPhone.</p><img alt="One-time Shahi pairing code" src="${image}"><p><a href="${url.replaceAll('&', '&amp;')}">Open in Shahi</a></p><p>Or copy this code into Shahi:</p><textarea readonly aria-label="Pairing code">${url.replaceAll('&', '&amp;')}</textarea><p><small>One use · expires in ten minutes. Anyone holding this code can access the demo computer.</small></p><p><a href="/">Back</a></p>`);
    }
    return new Response("Not found", { status: 404 });
  },
});

async function boot() {
  const restore = await stateRequest("GET");
  if (restore.ok) {
    await Bun.write("/run/shahi/restore.tar.gz", restore);
    await run(["python3", "/opt/demo/state.py", "restore", "/run/shahi/restore.tar.gz"]);
  } else if (restore.status !== 404) throw new Error("State unavailable; refusing to create a different identity");
  await run(["chown", "-R", "demo:demo", "/home/demo"]);
  mkdirSync("/home/demo/.codex", { recursive: true });
  await Bun.write("/home/demo/.codex/config.toml", Bun.file("/opt/demo/codex.toml"));
  await run(["chown", "-R", "demo:demo", "/home/demo/.codex"]);
  launch(["bun", "/opt/demo/model.js"]);
  launch(["herdr", "--session", "review", "server"]);
  const client = new HerdrClient({ socketPath: userEnv.HERDR_SOCKET_PATH });
  const deadline = Date.now() + 90_000;
  while (true) {
    try { await client.rpc("ping", {}); break; } catch { if (Date.now() > deadline) throw new Error("herdr unavailable"); await Bun.sleep(500); }
  }
  const { snapshot } = await client.rpc("session.snapshot", {});
  const workspaceId = snapshot.workspaces[0]?.workspace_id ?? (await client.rpc("workspace.create", { label: "Review demo", cwd: "/home/demo/workspace", focus: false })).workspace.workspace_id;
  const agents = await client.rpc("agent.list", {});
  if (!agents.agents.length) {
    const sample = await startAgentInTab((method, params, options) => client.rpc(method as never, params as never, options) as never,
      { workspaceId, cwd: "/home/demo/workspace", label: "Demo — simulated replies", kind: "codex", name: "review-demo", mode: "default" });
    // herdr can report a new pane before the interactive client settles.
    const until = Date.now() + 30_000;
    while (true) {
      try { await client.rpc("agent.prompt", { target: sample.paneId, text: "Hello. Explain this simulated review environment." }); break; }
      catch (error) { if (!String(error).includes("agent_not_ready") || Date.now() > until) throw error; await Bun.sleep(500); }
    }
  }
  launch(["bun", "/opt/demo/server.js"]);
  while (true) {
    try { if ((await local("/api/meta")).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error("Shahi unavailable"); await Bun.sleep(500);
  }
  await checkpoint();
  ready = true;
  setInterval(() => { void checkpoint().catch(() => { checkpointError = true; }); }, 15_000);
}
let stopping = false;
process.on("SIGTERM", async () => {
  if (stopping) return; stopping = true; ready = false;
  try { if (existsSync(data)) await checkpoint(); } catch {}
  for (const child of children) child.kill();
  process.exit(0);
});
void boot().catch(() => { console.error("Demo startup failed; no session data logged"); process.exit(1); });
