/** Explicit live check: disposable identities, synthetic GET responses, no herdr. */
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayClient } from "../lib/relay-client";
import { fromSeed } from "../lib/identity";
import { RelayLink } from "../../shared/src/relay-client";
import type { ServerWebSocket } from "bun";

if (process.env.SHAHI_RECOVERY_CHILD) {
  const config = JSON.parse(readFileSync(process.env.SHAHI_RECOVERY_CHILD, "utf8"));
  const secret = new Uint8Array(config.secret);
  new RelayClient({
    url: config.url, identity: fromSeed(new Uint8Array(config.seed)),
    devices: { secret: id => id === "recovery-probe" ? secret : null, revokedSecret: () => null },
    pairing: { secretByHash: () => null }, auth: { issue: () => "probe" },
    server: { dispatch: async () => Response.json({ probe: "recovery-ok" }), attach: () => {}, detach: () => {}, receive: () => {} },
    log: event => { if (event === "relay.connected" || event === "relay.resumed") appendFileSync(config.events, `${event}\n`); },
  }).start();
} else {
  if (process.env.SHAHI_LIVE_RELAY_RECOVERY !== "1") throw new Error("Set SHAHI_LIVE_RELAY_RECOVERY=1 to run this isolated live relay check");
  const upstreamBase = process.env.SHAHI_TEST_RELAY ?? "https://relay.getshahi.dev";
  const dir = mkdtempSync(join(tmpdir(), "shahi-relay-recovery-"));
  const events = join(dir, "events"); writeFileSync(events, "");
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const identity = fromSeed(seed);
  let mode: "online" | "offline" | "silent" = "online";
  type Wire = { upstream: WebSocket | null; path: string; queue: (string | Buffer)[] };
  const wires = new Set<ServerWebSocket<Wire>>();
  const proxy = Bun.serve<Wire>({ hostname: "127.0.0.1", port: 0,
    fetch(req, server) {
      if (mode === "offline") return new Response("test outage", { status: 503 });
      return server.upgrade(req, { data: { upstream: null, path: new URL(req.url).pathname, queue: [] } }) ? undefined : new Response("upgrade required", { status: 400 });
    },
    websocket: {
      open(ws) {
        wires.add(ws);
        const url = new URL(ws.data.path, upstreamBase); url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        const upstream = ws.data.upstream = new WebSocket(url); upstream.binaryType = "arraybuffer";
        upstream.onopen = () => { if (mode === "online") for (const data of ws.data.queue.splice(0)) upstream.send(data); };
        upstream.onmessage = e => { if (mode === "online") ws.send(typeof e.data === "string" ? e.data : new Uint8Array(e.data)); };
        upstream.onerror = () => ws.close(); upstream.onclose = () => ws.close();
      },
      message(ws, data) {
        if (mode !== "online") return;
        if (ws.data.upstream?.readyState === WebSocket.OPEN) ws.data.upstream.send(data);
        else ws.data.queue.push(typeof data === "string" ? data : Buffer.from(data));
      },
      close(ws) { wires.delete(ws); ws.data.upstream?.close(); },
    },
  });
  const url = `http://127.0.0.1:${proxy.port}`;
  const config = join(dir, "private.json");
  writeFileSync(config, JSON.stringify({ seed: [...seed], secret: [...secret], url, events }), { mode: 0o600 });
  const child = Bun.spawn([process.execPath, import.meta.path], { env: { ...process.env, SHAHI_RECOVERY_CHILD: config }, stdin: "ignore", stdout: "ignore", stderr: "inherit" });
  const phone = new RelayLink({ relay: url, serverId: identity.serverId, auth: { kind: "device", deviceId: "recovery-probe" }, secret });
  const connections = () => readFileSync(events, "utf8").split("relay.connected").length - 1;
  async function until(check: () => boolean, timeout = 90000) {
    const end = Date.now() + timeout;
    while (!check() && Date.now() < end) await Bun.sleep(100);
    if (!check()) throw new Error("Recovery deadline exceeded");
  }
  async function probe(label: string) {
    phone.ensureConnected(); await until(() => phone.state === "live");
    const response = await phone.request({ method: "GET", path: "/api/meta", headers: {}, body: null }, 15000);
    if ((await response.json() as {probe?:string}).probe !== "recovery-ok") throw new Error("Encrypted request failed");
    console.log(`PASS ${label}`);
  }
  try {
    await until(() => connections() > 0); await probe("initial encrypted request");
    let before = connections();
    process.kill(child.pid, "SIGSTOP"); await Bun.sleep(20000); process.kill(child.pid, "SIGCONT");
    await until(() => connections() > before); await probe("resume after 20-second process suspension");
    for (let i = 1; i <= 3; i++) {
      before = connections(); mode = "offline";
      for (const ws of wires) { ws.data.upstream?.close(); ws.terminate(); }
      await Bun.sleep(3000); mode = "online";
      await until(() => connections() > before); await probe(`network interruption ${i}`);
    }
    before = connections(); mode = "silent";
    await Bun.sleep(66000); mode = "online";
    await until(() => connections() > before); await probe("silent packet loss with no close notification");
    before = connections(); mode = "offline";
    for (const ws of wires) { ws.data.upstream?.close(); ws.terminate(); }
    await Bun.sleep(35000); mode = "online";
    await until(() => connections() > before); await probe("extended outage through capped retry backoff");
    console.log(`PASS same paired identity recovered across ${connections()} authenticated tunnel connections`);
  } finally {
    phone.close();
    if (child.exitCode === null) { process.kill(child.pid, "SIGCONT"); child.kill(); }
    await child.exited;
    for (const ws of wires) { ws.data.upstream?.close(); ws.terminate(); }
    proxy.stop(true); rmSync(dir, { recursive: true, force: true });
  }
}
