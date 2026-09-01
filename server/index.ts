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
import { dirname } from "node:path";
import { Auth } from "./lib/auth";
import { loadConfig } from "./lib/config";
import { HerdrClient, HerdrProtocolMismatch, HerdrSubscriber } from "./lib/herdr-client";
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

try {
  const { version, protocol } = await client.connect();
  console.log(`herdr ${version} (protocol ${protocol}) at ${config.socketPath}`);
} catch (err) {
  if (err instanceof HerdrProtocolMismatch) {
    // The socket API's exact behaviour is undocumented in places and pinned by
    // the generated types, so a protocol bump is a stop-and-look, not a warning.
    console.error(err.message);
    process.exit(1);
  }
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

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
});

store.on("error", (err) => console.error("state:", err.message));
poller.on("error", (err) => console.error("poller:", err.message));

// A closed pane should not keep its transcript or poll slot alive.
store.on("changed", () => {
  const live = new Set(store.state.panes.map((p) => p.pane_id));
  for (const paneId of trackedPanes) {
    if (!live.has(paneId)) {
      poller.forget(paneId);
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
  onError: (err) => console.error("events:", err.message),
});

await store.resync();
subscriber.start();
// Events keep the mirror responsive but do not keep it correct on their own —
// see the note in state.ts. This timer is what makes the dashboard trustworthy.
store.startSync();
poller.start();

const identity = serverIdentity(db);
const server = createServer({
  config,
  auth,
  client,
  store,
  poller,
  transcript,
  push,
  pairing,
  devices,
  serverId: identity.serverId,
});

// Dialled out, never listened on: with a relay the box is reachable from
// anywhere the relay is, with nothing opened here. See docs/relay.md.
const relay = config.relayUrl ? new RelayClient({ url: config.relayUrl, identity, devices, pairing, auth, server }) : null;
relay?.start();

const agents = store.state.agents.length;
const blocked = store.state.agents.filter((a) => a.agent_status === "blocked").length;

console.log(`listening on http://${config.host}:${config.port}`);
console.log(
  `  ${store.state.workspaces.length} workspaces, ${store.state.panes.length} panes, ` +
    `${agents} agents (${blocked} blocked)`,
);
console.log(`  passcode ${auth.disabled ? "DISABLED — anyone reaching this port has full control" : "required"}`);
console.log(`  push ${push.enabled ? `enabled, ${push.count()} subscription(s)` : "disabled (no VAPID keys)"}`);
console.log(`  devices ${devices.list().length} paired — pair a phone: bun run server/scripts/pair.ts`);
console.log(`  relay ${config.relayUrl ? `dialling ${config.relayUrl} as ${identity.serverId}` : "none (RELAY_URL not set); reachable directly only"}`);
console.log(`  data ${config.dataPath}`);

const loopback = config.host === "127.0.0.1" || config.host === "localhost" || config.host === "::1";

if (auth.disabled) {
  console.warn(
    "\n  No passcode set. Anyone who can reach this port has full control of\n" +
      "  every agent on this machine:\n" +
      "    bun run server/scripts/init-secrets.ts --passcode <digits>\n",
  );
}

if (!config.webRoot) {
  // Worth shouting about: everything else works, every health check passes, and
  // the phone gets a one-line placeholder instead of the app. That combination
  // cost an evening — the API was healthy the whole time.
  console.warn(
    "\n  WEB_ROOT is not set, so this is an API with no app in front of it.\n" +
      "  Run `bun run build:web`, then set WEB_ROOT=<repo>/web/dist and restart.\n",
  );
}

if (!loopback) {
  // Only loopback is a secure context. Off it, the browser refuses to register
  // a service worker, which is the sole delivery path for Web Push — so
  // notifications stop working silently unless this is said out loud.
  console.warn(
    `\n  Bound to ${config.host}, not loopback. Two consequences:\n` +
      "    - This address is not a secure context, so a browser here will not\n" +
      "      register a service worker and Web Push will not be delivered.\n" +
      "      The dashboard itself works fine.\n" +
      "    - The passcode is now the only thing between this port and full\n" +
      "      control of every agent here.\n" +
      "  Both are answered by putting TLS in front of it, which also keeps this\n" +
      "  address working:\n" +
      `    sudo tailscale serve --bg --https=443 http://${config.host}:${config.port}\n` +
      "  then use the https:// name rather than the address.\n",
  );

  if (config.host === "0.0.0.0" || config.host === "::") {
    console.warn(
      "  You bound ALL interfaces, which includes your LAN — not just the\n" +
        "  tailnet. Bind your Tailscale address specifically instead.\n",
    );
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`\n${signal} — shutting down`);
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
