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
import { loadComputerName } from "./lib/computer-name";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { refreshClaudeStatusLine } from "./lib/plan-usage";
import { Observability, rotatingLog } from "./lib/observability";
import { Auth } from "./lib/auth";
import { loadConfig } from "./lib/config";
import { HerdrClient, HerdrSubscriber } from "./lib/herdr-client";
import { BackendMonitor, probeHerdr } from "./lib/backend";
import { installedAgents } from "./lib/agents";
import { herdrCli, keepReaderIntegrations } from "./lib/herdr-integrations";
import { forgetChoice } from "./lib/claude-choice";
import { PaneInstances } from "./lib/herdr-pane";
import { ComputerControl } from "./lib/control";
import { createServer, type ShahiServer } from "./lib/http";
import { serverIdentity } from "./lib/identity";
import { Devices, Pairing, pairCommand } from "./lib/pairing";
import { Poller } from "./lib/poller";
import { PushService } from "./lib/push";
import { RelayClient } from "./lib/relay-client";
import { SessionStore } from "./lib/state";
import { TranscriptStore } from "./lib/transcript";

/**
 * A failed start is one line with the time, and exit 1. Thrown instead, Bun
 * printed five lines of the minified release around the cause — a taken
 * port, a bad .env value — about 5 KB, and the manager started it again every
 * few seconds, so the log grew by 127 MB a day and said the same thing once
 * per 5 KB (pre-release bug hunt). Nothing is lost: the release has no source
 * maps, so that context was never readable.
 */
function orExit<T>(start: () => T): T {
  try {
    return start();
  } catch (err) {
    const said = (err instanceof Error ? err.message : String(err)).replace(/\s*\n\s*/g, " ");
    console.error(`${new Date().toISOString()} Shahi could not start: ${said}`);
    process.exit(1);
  }
}

const config = orExit(() => loadConfig());

const client = new HerdrClient({ socketPath: config.socketPath });

// The database holds the box's identity seed and every device secret — the
// long-lived half of every relay session's keys. Bun creates it with the
// process umask (0644 here), so a directory nobody else can enter is the
// durable fix: it covers the WAL and shm files SQLite makes beside it too
// (2026-09-02 review, R4). `.env` has been 0600 since it was first written.
const dataDir = dirname(config.dataPath);
const db = orExit(() => {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const db = new Database(config.dataPath, { create: true });
  chmodSync(config.dataPath, 0o600);
  db.exec("PRAGMA journal_mode = WAL");
  return db;
});

const observability = new Observability(rotatingLog(join(dataDir, "operations.jsonl")));
// An update can move Bun or rewrite the status line script Claude Code runs
// for plan usage; only an installed one is touched (plan-usage.ts).
void refreshClaudeStatusLine({ dataDir, bun: process.execPath }).catch(() => {});
const store = new SessionStore(client, new PaneInstances(db));
const transcript = new TranscriptStore(config.dataPath);
const poller = new Poller(client, store, transcript);
const push = new PushService(db, config, observability.event);
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
      forgetChoice(paneId);
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

/**
 * herdr's integrations for the agents Reader follows (herdr-integrations.ts),
 * once per start, and only as the managed service talking to a real herdr:
 * the live suite and the release smoke tests start this file with the
 * developer's own home, and an integration install writes an agent's real
 * settings. Neither those nor a development checkout has both.
 */
let integrationsChecked = false;
function checkReaderIntegrations(): void {
  if (integrationsChecked || !process.env.SHAHI_MANAGER_ROOT) return;
  integrationsChecked = true;
  const bin = process.env.HERDR_BIN_PATH ?? "herdr";
  void keepReaderIntegrations({
    herdr: (args) => herdrCli(bin, args),
    // The same question the New Agent sheet asks, whose answer is cached for
    // whoever asks next: asking about fewer kinds would hide the rest there.
    installed: async (kinds) => {
      const { manifests } = await client.rpc("server.agent_manifests", {});
      const found = new Set((await installedAgents(manifests.map((m) => m.agent))).map((agent) => agent.kind));
      return kinds.filter((kind) => found.has(kind));
    },
    seenPath: join(dirname(config.dataPath), "herdr-integrations.json"),
  }).then((lines) => { for (const line of lines) console.log(`  ${line}`); });
}

const backend = new BackendMonitor(
  () => probeHerdr(() => client.rpc("ping", {}), store, () => backend.state.state === "connected"),
  async () => {
    await store.resync();
    if (!store.lastSyncOk) throw new Error("herdr snapshot unavailable");
    subscriber.start(); store.startSync(); poller.start();
    checkReaderIntegrations();
  },
  () => { subscriber.stop(); store.stopSync(); poller.stop(); },
);

const identity = serverIdentity(db);
// Listening is where a port another program holds fails.
// Named before the first snapshot is built (computer-name.ts).
await loadComputerName();
const server: ShahiServer = orExit(() => createServer({
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
}));

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
console.log(`  devices ${devices.list().length} paired — pair a phone: ${pairCommand()}`);
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
