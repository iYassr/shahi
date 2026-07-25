/**
 * HerdrUI server.
 *
 * A sidecar beside a running herdr server: it owns herdr's unix socket and
 * provides the three things herdr deliberately does not — HTTP, WebSocket, and
 * authentication. Runs on the same host by necessity; herdr has no network
 * surface of any kind.
 *
 *   bun run start          # or `bun run dev` to reload on change
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Auth } from "./lib/auth";
import { loadConfig } from "./lib/config";
import { HerdrClient, HerdrProtocolMismatch, HerdrSubscriber } from "./lib/herdr-client";
import { createServer } from "./lib/http";
import { Poller } from "./lib/poller";
import { PushService } from "./lib/push";
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

mkdirSync(dirname(config.dataPath), { recursive: true });
const db = new Database(config.dataPath, { create: true });
db.exec("PRAGMA journal_mode = WAL");

const store = new SessionStore(client);
const transcript = new TranscriptStore(config.dataPath);
const poller = new Poller(client, store, transcript);
const push = new PushService(db, config);
const auth = new Auth({
  passcodeHash: config.passcodeHash,
  sessionSecret: config.sessionSecret,
  sessionTtlMs: config.sessionTtlMs,
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

const server = createServer({ config, auth, client, store, poller, transcript, push });

const agents = store.state.agents.length;
const blocked = store.state.agents.filter((a) => a.agent_status === "blocked").length;

console.log(`listening on http://${config.host}:${config.port}`);
console.log(
  `  ${store.state.workspaces.length} workspaces, ${store.state.panes.length} panes, ` +
    `${agents} agents (${blocked} blocked)`,
);
console.log(`  passcode ${auth.disabled ? "DISABLED — anyone reaching this port has full control" : "required"}`);
console.log(`  push ${push.enabled ? `enabled, ${push.count()} subscription(s)` : "disabled (no VAPID keys)"}`);
console.log(`  data ${config.dataPath}`);

const loopback = config.host === "127.0.0.1" || config.host === "localhost" || config.host === "::1";

if (auth.disabled) {
  console.warn(
    "\n  No passcode set. Anyone who can reach this port has full control of\n" +
      "  every agent on this machine:\n" +
      "    bun run server/scripts/init-secrets.ts --passcode <digits>\n",
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
    server.stop();
    transcript.close();
    db.close();
    process.exit(0);
  });
}
