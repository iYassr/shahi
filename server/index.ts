/**
 * Shahi server.
 *
 * A sidecar beside a running herdr server: it owns herdr's unix socket and
 * provides the three things herdr deliberately does not — HTTP, WebSocket, and
 * authentication. Runs on the same host by necessity; herdr has no network
 * surface of any kind.
 *
 *   bun run start          # or `bun run dev` to reload on change
 */
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Observability, rotatingLog } from "./lib/observability";
import { Auth } from "./lib/auth";
import { loadConfig } from "./lib/config";
import { HerdrClient, HerdrSubscriber } from "./lib/herdr-client";
import { BackendMonitor } from "./lib/backend";
import { ComputerControl } from "./lib/control";
import { createServer } from "./lib/http";
import { serverIdentity } from "./lib/identity";
import { Devices, Pairing } from "./lib/pairing";
import { Poller } from "./lib/poller";
import { PushService } from "./lib/push";
import { RelayClient } from "./lib/relay-client";
import { SessionStore } from "./lib/state";
import { TranscriptStore } from "./lib/transcript";

const config = loadConfig();

const client = new HerdrClient({ socketPath: config.socketPath });

// The database holds the box's identity seed and every device secret — the
// long-lived half of every relay session's keys. Bun creates it with the
// process umask (0644 here), so a directory nobody else can enter is the
// durable fix: it covers the WAL and shm files SQLite makes beside it too
// (2026-09-02 review, R4). `.env` has been 0600 since it was first written.
const dataDir = dirname(config.dataPath);
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
chmodSync(dataDir, 0o700);
const db = new Database(config.dataPath, { create: true });
chmodSync(config.dataPath, 0o600);
db.exec("PRAGMA journal_mode = WAL");

const store = new SessionStore(client);
const transcript = new TranscriptStore(config.dataPath);
const poller = new Poller(client, store, transcript);
const push = new PushService(db, config);
const devices = new Devices(db);
const pairing = new Pairing();
const auth = new Auth({
  passcodeHash: config.passcodeHash,
  sessionSecret: config.sessionSecret,
  sessionTtlMs: config.sessionTtlMs,
  // Asked on every request that carries a device token, so a revoked phone is
  // out immediately rather than at cookie expiry. See pairing.ts.
  deviceActive: (id) => devices.isActive(id),
}, db);

const observability = new Observability(rotatingLog(join(dataDir, "operations.jsonl")));
store.on("error", () => observability.event("state.error"));
poller.on("error", () => observability.event("poller.error"));

// A closed pane should not keep its transcript or poll slot alive. Both
// `forget`s were meant to run here — the transcript's docstring even says
// "Called when herdr reports the pane closed" — but only the poller's was
// wired, so a box that runs for weeks kept every dead pane's recorded rows in
// SQLite and two in-memory maps forever (pre-release review). Now both drop.
store.on("changed", () => {
  const live = new Set(store.state.panes.map((p) => p.pane_id));
  for (const paneId of trackedPanes) {
    if (!live.has(paneId)) {
      poller.forget(paneId);
      transcript.forget(paneId);
      trackedPanes.delete(paneId);
    }
  }
  for (const paneId of live) trackedPanes.add(paneId);
});
const trackedPanes = new Set<string>();

const subscriber = new HerdrSubscriber({
  onEvent: (event) => store.apply(event),
  // herdr has no event replay, so a reconnect means resyncing from scratch.
  onResync: () => store.resync(),
  onError: () => observability.event("subscriber.error"),
});

const backend = new BackendMonitor(
  async () => {
    const pong = await client.rpc("ping", {});
    if (backend.state.state === "connected" && !store.lastSyncOk) throw new Error("herdr snapshot unavailable");
    return pong;
  },
  async () => {
    await store.resync();
    if (!store.lastSyncOk) throw new Error("herdr snapshot unavailable");
    subscriber.start(); store.startSync(); poller.start();
  },
  () => { subscriber.stop(); store.stopSync(); poller.stop(); },
);

const identity = serverIdentity(db);
const server = createServer({
  control: new ComputerControl(identity.serverId, () => backend.state),
  config,
  observability,
  auth,
  client,
  store,
  poller,
  transcript,
  push,
  pairing,
  devices,
  serverId: identity.serverId,
  // Created below, because it needs this server; read at request time.
  relay: () => (relay ? { url: config.relayUrl!, connected: relay.connected } : null),
});

// Dialled out, never listened on: with a relay the box is reachable from
// anywhere the relay is, with nothing opened here. See docs/relay.md.
const relay = config.relayUrl ? new RelayClient({ url: config.relayUrl, identity, devices, pairing, auth, server, log: observability.event }) : null;
relay?.start();
backend.run();
observability.event("runtime.started");
let lastMetricsTick = Date.now();
const metricsTimer = setInterval(() => {
  const now = Date.now();
  observability.tick(relay?.connected ?? null, Math.max(0, now - lastMetricsTick - 60_000));
  lastMetricsTick = now;
}, 60_000);

const agents = store.state.agents.length;
const blocked = store.state.agents.filter((a) => a.agent_status === "blocked").length;

console.log(`listening on http://${config.host}:${config.port}`);
console.log(
  `  ${store.state.workspaces.length} workspaces, ${store.state.panes.length} panes, ` +
    `${agents} agents (${blocked} blocked)`,
);
console.log("  passcode required");
console.log(`  push ${push.enabled ? `enabled, ${push.count()} subscription(s)` : "disabled (no VAPID keys)"}`);
console.log(`  devices ${devices.list().length} paired — pair a phone: bun run server/scripts/pair.ts`);
console.log(`  relay ${config.relayUrl ? `dialling ${config.relayUrl} as ${identity.serverId}` : "none (RELAY_URL not set); reachable directly only"}`);
console.log(`  data ${config.dataPath}`);

if (!config.webRoot) {
  // Worth shouting about: everything else works, every health check passes, and
  // the phone gets a one-line placeholder instead of the app. That combination
  // cost an evening — the API was healthy the whole time.
  console.warn(
    "\n  WEB_ROOT is not set, so this is an API with no app in front of it.\n" +
      "  Run `bun run build:web`, then set WEB_ROOT=<repo>/web/dist and restart.\n",
  );
}

// A crashed supervisor must not leave an orphan holding the port while its
// replacement starts. Bun's IPC channel closes when the manager disappears.
if (process.connected) process.on("disconnect", () => process.emit("SIGTERM"));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`\n${signal} — shutting down`);
    clearInterval(metricsTimer);
    backend.close();
    observability.event("runtime.stopped");
    subscriber.stop();
    store.stopSync();
    poller.stop();
    relay?.stop();
    server.stop();
    transcript.close();
    db.close();
    process.exit(0);
  });
}
