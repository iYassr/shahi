/** Isolated encrypted box fixture: every command terminates at the recording stub. */
import { join, resolve } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { ephemeral, open, seal, serverSession, type Session as CryptoSession } from "../../shared/src/e2e";
import { RELAY_PROTOCOL, SHAHI_API_VERSION, type PhoneHello, type PhoneToBox } from "../../shared/src/index";
import type { ServerWebSocket } from "bun";

const port = Number(process.env.HOSTED_PORT ?? 7472);
const apiPort = port + 1;
process.env.PORT = String(apiPort);
await import("../stub/server");
const apiBase = `http://127.0.0.1:${apiPort}`;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const bytes = (text: string) => new Uint8Array(Buffer.from(text, "base64url"));
const encoder = new TextEncoder();
const serverId = b64(sha256(encoder.encode("isolated-hosted-browser-fixture")));
let pairingSecret = crypto.getRandomValues(new Uint8Array(32));
let pairingUsed = false;
const devices = new Map<string, { secret: Uint8Array; name: string }>();
const links = new Set<ServerWebSocket<Link>>();
const transcript: { path: string; method: string }[] = [];
interface Link { session?: CryptoSession; deviceId?: string; pairing: boolean; stream?: WebSocket }
const root = resolve(import.meta.dir, "../../web/dist-hosted");
function send(ws: ServerWebSocket<Link>, value: unknown) { if (ws.data.session) ws.send(seal(ws.data.session, encoder.encode(JSON.stringify(value)))); }
function revoke(id: string) {
  devices.delete(id);
  for (const ws of links) if (ws.data.deviceId === id) { send(ws, { t: "bye" }); ws.close(1000); }
}
const fixture = Bun.serve<Link>({
  hostname: "127.0.0.1", port,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/__hosted/ready") return Response.json({ fixture: true });
    if (url.pathname === "/__hosted/reset" && req.method === "POST") {
      for (const ws of links) ws.close(1000);
      devices.clear(); pairingSecret = crypto.getRandomValues(new Uint8Array(32)); pairingUsed = false; transcript.length = 0;
      await fetch(`${apiBase}/__stub/scenario`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "busy" }) });
      const fields = new URLSearchParams({ v: "1", server: serverId, relay: `http://127.0.0.1:${port}`, secret: b64(pairingSecret) });
      return Response.json({ code: `shahi://pair#${fields}`, web: `http://127.0.0.1:${port}/pwa/#pair=${encodeURIComponent(`shahi://pair#${fields}`)}` });
    }
    if (url.pathname === "/__hosted/writes") return Response.json({ requests: transcript, ...(await (await fetch(`${apiBase}/__stub/writes`)).json() as object) });
    if (url.pathname === "/__hosted/revoke" && req.method === "POST") { for (const id of devices.keys()) revoke(id); return Response.json({ ok: true }); }
    if (url.pathname === `/v1/phone/${serverId}`) return srv.upgrade(req, { data: { pairing: false } }) ? undefined : new Response(null, { status: 400 });
    // Deliberately no /api: the hosted client must never use the marketing origin as its box.
    if (!url.pathname.startsWith("/pwa/")) return new Response("not found", { status: 404 });
    let relative: string;
    try { relative = decodeURIComponent(url.pathname.slice(5)); } catch { return new Response(null, { status: 400 }); }
    const path = resolve(root, relative || "index.html");
    if (!path.startsWith(`${root}/`)) return new Response(null, { status: 404 });
    let file = Bun.file(path);
    if (!(await file.exists())) {
      if (relative.split("/").at(-1)?.includes(".")) return new Response(null, { status: 404 });
      file = Bun.file(join(root, "index.html"));
    }
    return new Response(file, { headers: {
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self' ws://127.0.0.1:*; worker-src 'self'; manifest-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Permissions-Policy": "camera=(self), microphone=(), geolocation=()", "Cache-Control": "no-cache",
    } });
  },
  websocket: {
    open(ws) { links.add(ws); },
    async message(ws, raw) {
      try {
        if (!ws.data.session) {
          const hello = JSON.parse(new TextDecoder().decode(new Uint8Array(raw as Buffer))) as PhoneHello;
          if (hello.t !== "hello" || hello.v !== RELAY_PROTOCOL) throw new Error("invalid hello");
          let secret: Uint8Array | undefined;
          if (hello.auth.kind === "pairing" && !pairingUsed && hello.auth.id === b64(sha256(pairingSecret))) { secret = pairingSecret; ws.data.pairing = true; }
          if (hello.auth.kind === "device") { secret = devices.get(hello.auth.deviceId)?.secret; ws.data.deviceId = hello.auth.deviceId; }
          if (!secret) { ws.close(4401); return; }
          const self = ephemeral(crypto.getRandomValues(new Uint8Array(32)));
          ws.data.session = serverSession(self, bytes(hello.pub), secret);
          ws.send(encoder.encode(JSON.stringify({ t: "hello", v: RELAY_PROTOCOL, pub: b64(self.pub) })));
          if (ws.data.deviceId) {
            const stream = new WebSocket(`${apiBase.replace("http", "ws")}/ws`, { headers: { cookie: "shahi_session=stub" } } as never);
            ws.data.stream = stream;
            stream.onmessage = event => send(ws, { t: "ws", data: JSON.parse(String(event.data)) });
          }
          return;
        }
        const message = JSON.parse(new TextDecoder().decode(open(ws.data.session, new Uint8Array(raw as Buffer)))) as PhoneToBox;
        if (message.t === "ws") {
          if (!ws.data.deviceId || !devices.has(ws.data.deviceId)) throw new Error("not paired");
          // The recording stub provides the live session and pane frames too.
          if (!ws.data.stream) {
            const stream = new WebSocket(`${apiBase.replace("http", "ws")}/ws`, { headers: { cookie: "shahi_session=stub" } } as never);
            ws.data.stream = stream;
            stream.onmessage = event => send(ws, { t: "ws", data: JSON.parse(String(event.data)) });
            stream.onopen = () => stream.send(JSON.stringify(message.data));
          } else if (ws.data.stream.readyState === WebSocket.OPEN) ws.data.stream.send(JSON.stringify(message.data));
          return;
        }
        if (message.t !== "req" || !message.path.startsWith("/api/")) throw new Error("invalid path");
        transcript.push({ path: message.path, method: message.method });
        const body = message.body === null ? undefined : bytes(message.body);
        let response: Response;
        if (message.path === "/api/meta") response = Response.json({ serverId, api: { min: SHAHI_API_VERSION, max: SHAHI_API_VERSION } });
        else if (message.path === "/api/pair/claim" && ws.data.pairing) {
          const claim = JSON.parse(new TextDecoder().decode(body));
          if (pairingUsed || claim.secret !== b64(pairingSecret)) response = Response.json({ error: "Expired pairing code" }, { status: 401 });
          else {
            pairingUsed = true;
            const id = crypto.randomUUID(), secret = crypto.getRandomValues(new Uint8Array(32));
            devices.set(id, { secret, name: claim.deviceName });
            response = Response.json({ ok: true, deviceId: id, deviceSecret: b64(secret) });
          }
        } else if (!ws.data.deviceId || !devices.has(ws.data.deviceId)) response = Response.json({ error: "unauthorized" }, { status: 401 });
        else if (message.path === "/api/devices") response = Response.json({ currentDeviceId: ws.data.deviceId, devices: [...devices].map(([id, d]) => ({ id, name: d.name, createdAt: Date.now(), lastSeenAt: Date.now() })) });
        else if (message.path === "/api/auth/logout") { devices.delete(ws.data.deviceId); response = Response.json({ ok: true }); }
        else {
          const headers = new Headers(message.headers); headers.set("cookie", "shahi_session=stub");
          const target = new URL(message.path, apiBase);
          if (target.origin !== apiBase) throw new Error("escaped fixture");
          response = await fetch(target, { method: message.method, headers, body });
        }
        send(ws, { t: "res", id: message.id, status: response.status, headers: Object.fromEntries(response.headers), body: b64(new Uint8Array(await response.arrayBuffer())) });
      } catch { ws.close(4400, "invalid fixture frame"); }
    },
    close(ws) { links.delete(ws); ws.data.stream?.close(); },
  },
});
console.log(`Hosted browser fixture on ${fixture.port}`);
