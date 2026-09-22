import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";

// Freeze only an isolated child process, never the user's Mac, Wi-Fi or service.
// Real sockets exercise timer suspension and reconnect without mocking Date.
test("a suspended computer process opens a fresh tunnel and survives network flaps", async () => {
  let available = true;
  let authenticated = 0;
  const sockets = new Set<ServerWebSocket<unknown>>();
  const relay = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (!available) return new Response("offline", { status: 503 });
      return server.upgrade(req) ? undefined : new Response("upgrade required", { status: 400 });
    },
    websocket: {
      open(ws) { sockets.add(ws); ws.send(JSON.stringify({ t: "challenge", nonce: "a".repeat(43) })); },
      message(ws, data) {
        if (String(data) === "ping") { ws.send("pong"); return; }
        if (JSON.parse(String(data)).t === "auth") { authenticated++; ws.send('{"t":"ready"}'); }
      },
      close(ws) { sockets.delete(ws); },
    },
  });
  const source = `
    import { RelayClient } from ${JSON.stringify(new URL("./relay-client.ts", import.meta.url).pathname)};
    import { fromSeed } from ${JSON.stringify(new URL("./identity.ts", import.meta.url).pathname)};
    const client = new RelayClient({url:"http://127.0.0.1:${relay.port}",
      identity:fromSeed(new Uint8Array(32)),devices:{secret:()=>null,revokedSecret:()=>null},pairing:{secretByHash:()=>null},auth:{issue:()=>"test"},
      server:{dispatch:async()=>new Response(),attach:()=>{},detach:()=>{},receive:()=>{}}},
      {watchdogMs:20,resumeGapMs:150,pingMs:30,silenceMs:5000,minBackoffMs:20,maxBackoffMs:80,authTimeoutMs:200});
    client.start();
  `;
  const child = Bun.spawn([process.execPath, "-e", source], { stdin: "ignore", stdout: "ignore", stderr: "inherit" });
  async function waitFor(check: () => boolean) {
    const deadline = Date.now() + 3000;
    while (!check() && Date.now() < deadline) await Bun.sleep(10);
    expect(check()).toBe(true);
  }
  try {
    await waitFor(() => authenticated === 1);
    process.kill(child.pid, "SIGSTOP");
    await Bun.sleep(350);
    process.kill(child.pid, "SIGCONT");
    await waitFor(() => authenticated >= 2);
    for (let i = 0; i < 3; i++) {
      const before = authenticated;
      available = false;
      for (const ws of sockets) ws.terminate();
      await Bun.sleep(250);
      available = true;
      await waitFor(() => authenticated > before);
    }
    const beforeOfflineWake = authenticated;
    process.kill(child.pid, "SIGSTOP");
    available = false;
    for (const ws of sockets) ws.terminate();
    await Bun.sleep(350);
    process.kill(child.pid, "SIGCONT");
    await Bun.sleep(350);
    available = true;
    await waitFor(() => authenticated > beforeOfflineWake);
    await waitFor(() => sockets.size === 1);
    expect(child.exitCode).toBeNull();
  } finally {
    process.kill(child.pid, "SIGCONT"); child.kill(); await child.exited;
    relay.stop(true);
  }
}, 15000);
