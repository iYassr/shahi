/** Real Worker + real sidecar, with no real herdr or user credentials. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientSession, ephemeral, open, seal } from "@shahi/shared/e2e";
import { RELAY_PROTOCOL } from "@shahi/shared";
import { Auth } from "../../server/lib/auth";
import { Devices, Pairing } from "../../server/lib/pairing";
import { serverIdentity } from "../../server/lib/identity";
import { RelayClient } from "../../server/lib/relay-client";
import { createServer, type ShahiServer } from "../../server/lib/http";
import { SessionStore } from "../../server/lib/state";
import { Poller } from "../../server/lib/poller";
import { PushService } from "../../server/lib/push";
import { TranscriptStore } from "../../server/lib/transcript";
import type { Config } from "../../server/lib/config";
import type { HerdrClient } from "../../server/lib/herdr-client";
import { startRelay, Peer, HTTP, WS } from "./harness";

const scratch = mkdtempSync(join(tmpdir(), "shahi-relay-security-"));
const db = new Database(join(scratch, "devices.sqlite"));
const devices = new Devices(db);
const pairing = new Pairing();
const identity = serverIdentity(db);
const transcript = new TranscriptStore(join(scratch, "transcript.sqlite"));
const peers: Peer[] = [];
let server: ShahiServer;
let relay: RelayClient;
let stopRelay = () => {};
const encoder = new TextEncoder();

beforeAll(async () => {
  stopRelay = await startRelay();
  const config: Config = {
    host: "127.0.0.1", port: 0, socketPath: "", dataPath: join(scratch, "devices.sqlite"),
    passcodeHash: "configured-test-gate", sessionSecret: "isolated-session-test-secret",
    sessionTtlMs: 60_000, vapid: null, webRoot: null, relayUrl: HTTP,
  };
  const auth = new Auth({ ...config, deviceActive: (id) => devices.isActive(id) }, db);
  const client = { rpc: async (method: string) => {
    if (method === "session.snapshot") return { snapshot: {
      version: "0.8.2", protocol: 20, workspaces: [], tabs: [], panes: [], agents: [], layouts: [], focused_pane_id: null,
    } };
    throw new Error(`Real herdr calls forbidden: ${method}`);
  } } as unknown as HerdrClient;
  const store = new SessionStore(client);
  await store.resync();
  const poller = new Poller(client, store, transcript);
  server = createServer({ config, auth, client, store, poller, transcript, push: new PushService(db, config), pairing, devices, serverId: identity.serverId }, { heartbeatMs: 20 });
  relay = new RelayClient({ url: HTTP, identity, devices, pairing, auth, server, log() {} }, { phoneAuthMs: 1500 });
  relay.start();
  for (let i = 0; !relay.connected && i < 500; i++) await Bun.sleep(10);
  expect(relay.connected).toBe(true);
}, 90_000);

afterAll(async () => {
  for (const p of peers) p.close();
  relay?.stop(); server?.stop(true); transcript.close(); db.close();
  await Bun.sleep(50);
  stopRelay(); rmSync(scratch, { recursive: true, force: true });
});

async function hello(deviceId: string) {
  const peer = await Peer.open(`${WS}/v1/phone/${identity.serverId}`);
  peers.push(peer);
  const key = ephemeral(crypto.getRandomValues(new Uint8Array(32)));
  peer.send(encoder.encode(JSON.stringify({ t: "hello", v: RELAY_PROTOCOL, pub: Buffer.from(key.pub).toString("base64url"), auth: { kind: "device", deviceId } })));
  const answer = JSON.parse(new TextDecoder().decode(await peer.binary())) as { pub: string };
  return { peer, key, pub: new Uint8Array(Buffer.from(answer.pub, "base64url")) };
}

test("eight valid-looking device hellos get no stream and expire, allowing a real device in", async () => {
  const { device, secret } = devices.create("Synthetic phone");
  const squatters: Peer[] = [];
  for (let i = 0; i < 8; i++) squatters.push((await hello(device.id)).peer);
  // No encrypted dashboard or heartbeat is sent before client proof.
  expect(await squatters[0]!.hears(80)).toBe(false);
  const refused = await Peer.open(`${WS}/v1/phone/${identity.serverId}`);
  peers.push(refused);
  expect((await refused.closed).code).toBe(4429);
  const closed = await Promise.all(squatters.map((p) => p.closed));
  expect(closed.every((event) => event.code === 1000)).toBe(true);

  const real = await hello(device.id);
  const session = clientSession(real.key, real.pub, secret);
  real.peer.send(seal(session, encoder.encode(JSON.stringify({ t: "ws", data: { type: "unwatch" } }))));
  const dashboard = JSON.parse(new TextDecoder().decode(open(session, await real.peer.binary())));
  expect(dashboard).toMatchObject({ t: "ws", data: { type: "session" } });
  real.peer.close();
}, 5000);

test("revocation between hello and proof cannot establish a session", async () => {
  const { device, secret } = devices.create("Revoked during handshake");
  const pending = await hello(device.id);
  devices.revoke(device.id);
  pending.peer.send(seal(clientSession(pending.key, pending.pub, secret), encoder.encode(JSON.stringify({ t: "ws", data: { type: "unwatch" } }))));
  expect((await pending.peer.closed).code).toBe(1000);
  expect(await pending.peer.hears(50)).toBe(false);
});

test("authenticated JSON null and arrays end only their link", async () => {
  const { device, secret } = devices.create("Malformed messages");
  for (const value of [null, [], 3, { t: "unknown" }]) {
    const pending = await hello(device.id);
    pending.peer.send(seal(clientSession(pending.key, pending.pub, secret), encoder.encode(JSON.stringify(value))));
    expect((await pending.peer.closed).code).toBe(1000);
    expect((await fetch(`http://127.0.0.1:${server.port}/api/auth/status`)).status).toBe(200);
  }
});
