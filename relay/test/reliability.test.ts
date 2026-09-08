import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { RelayClient } from "../../server/lib/relay-client";
import { serverIdentity } from "../../server/lib/identity";
import type { StreamClient } from "../../server/lib/http";
import { RelayLink, toBase64Url } from "../../shared/src/relay-client";
import { RELAY_LIMITS, RELAY_PROTOCOL } from "../../shared/src/relay";
import { clientSession, ephemeral, seal } from "../../shared/src/e2e";
import { HTTP, WS, Peer, startRelay } from "./harness";

let stopRelay = () => {};
beforeAll(async () => { stopRelay = await startRelay(); }, 90_000);
afterAll(() => stopRelay());

async function fixture() {
  const db = new Database(":memory:");
  const identity = serverIdentity(db);
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const clients = new Set<StreamClient>();
  const events: string[] = [];
  let dispatch = async () => new Response("ok");
  const sidecar = new RelayClient({ url: HTTP, identity, devices: { secret: () => secret }, pairing: { secretByHash: () => null }, auth: { issue: () => "synthetic" },
    server: { attach: (c) => { clients.add(c); }, detach: (c) => { clients.delete(c); }, receive() {}, dispatch: () => dispatch() }, log: (event) => { events.push(event); } });
  sidecar.start();
  for (let n = 0; !sidecar.connected && n < 500; n++) await Bun.sleep(10);
  expect(sidecar.connected).toBe(true);
  const links: RelayLink[] = [];
  const connect = async () => {
    const link = new RelayLink({ relay: HTTP, serverId: identity.serverId, secret, auth: { kind: "device", deviceId: "synthetic" } });
    links.push(link);
    expect((await link.request({ method: "GET", path: "/api/meta", headers: {}, body: null }, 5000)).status).toBe(200);
    return link;
  };
  return { identity, secret, clients, sidecar, events, connect, dispatch: (fn: typeof dispatch) => { dispatch = fn; }, close() { for (const l of links) l.close(); sidecar.stop(); db.close(); } };
}

test("a slow phone without delivery acknowledgments is removed while a healthy phone continues", async () => {
  const f = await fixture();
  let slow: Peer | undefined;
  try {
    const healthy = await f.connect();
    slow = await Peer.open(`${WS}/v1/phone/${f.identity.serverId}`);
    const key = ephemeral(crypto.getRandomValues(new Uint8Array(32)));
    slow.send(new TextEncoder().encode(JSON.stringify({ t: "hello", v: RELAY_PROTOCOL, pub: toBase64Url(key.pub), auth: { kind: "device", deviceId: "slow" } })));
    const answer = JSON.parse(new TextDecoder().decode(await slow.binary()));
    const session = clientSession(key, new Uint8Array(Buffer.from(answer.pub, "base64url")), f.secret);
    slow.send(seal(session, new TextEncoder().encode('{"t":"ws","data":{"type":"unwatch"}}')));
    for (let n = 0; f.clients.size < 2 && n < 100; n++) await Bun.sleep(10);
    expect(f.clients.size).toBe(2);
    const stalled = [...f.clients][1]!;
    for (let n = 0; n < 40 && f.clients.has(stalled); n++) {
      stalled.send(JSON.stringify({ type: "test", data: "x".repeat(65536) }));
      await Bun.sleep(2);
    }
    expect((await slow.closed).code).toBe(1000);
    expect(f.clients.size).toBe(1);
    expect(f.sidecar.connected).toBe(true);
    expect((await healthy.request({ method: "GET", path: "/api/meta", headers: {}, body: null }, 5000)).status).toBe(200);
  } finally { slow?.close(); f.close(); }
}, 15_000);

test("a streaming oversized response is cancelled with 413 and other work still succeeds", async () => {
  const f = await fixture();
  try {
    const link = await f.connect();
    let cancelled = false, generated = 0;
    f.dispatch(async () => new Response(new ReadableStream({ pull(c) { generated += 65536; c.enqueue(new Uint8Array(65536)); }, cancel() { cancelled = true; } })));
    expect((await link.request({ method: "GET", path: "/api/file", headers: {}, body: null }, 5000)).status).toBe(413);
    expect(cancelled).toBe(true);
    expect(generated).toBeLessThan(RELAY_LIMITS.maxBodyBytes + 2 * 65536);
    f.dispatch(async () => new Response("ok"));
    expect((await link.request({ method: "GET", path: "/api/meta", headers: {}, body: null }, 5000)).status).toBe(200);
  } finally { f.close(); }
});

test("one device cannot occupy more than four sidecar requests", async () => {
  const f = await fixture();
  const finish: (() => void)[] = [];
  try {
    const link = await f.connect();
    f.dispatch(() => new Promise((resolve) => { finish.push(() => resolve(new Response("ok"))); }));
    const calls = Array.from({ length: 4 }, () => link.request({ method: "GET", path: "/api/session", headers: {}, body: null }, 5000));
    for (let n = 0; finish.length < 4 && n < 100; n++) await Bun.sleep(10);
    expect((await link.request({ method: "GET", path: "/api/session", headers: {}, body: null }, 5000)).status).toBe(429);
    expect(finish).toHaveLength(4);
    for (const done of finish) done();
    expect((await Promise.all(calls)).every((r) => r.status === 200)).toBe(true);
  } finally { for (const done of finish) done(); f.close(); }
});
