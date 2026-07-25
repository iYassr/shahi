/**
 * Measures whether the event-driven mirror stays true to herdr.
 *
 * The mirror is seeded from `session.snapshot` and patched by events, on the
 * assumption that the unfiltered `pane.updated` topic reports every
 * `agent_status` transition. If that assumption is wrong the dashboard silently
 * drifts — showing agents as working long after they blocked, which is exactly
 * the failure the app exists to prevent.
 *
 * Compares the mirror against a fresh snapshot every few seconds and reports
 * any divergence. Read-only.
 *
 *   bun run server/scripts/check-mirror-drift.ts [seconds]
 */
import { HerdrClient, HerdrSubscriber } from "../lib/herdr-client";
import { SessionStore } from "../lib/state";

const seconds = Number(process.argv[2] ?? 90);
/** `--events-only` reproduces the original bug: no periodic snapshot. */
const eventsOnly = process.argv.includes("--events-only");

const client = new HerdrClient();
await client.connect();

const store = new SessionStore(client);
const subscriber = new HerdrSubscriber({
  onEvent: (event) => store.apply(event),
  onResync: () => store.resync(),
  onError: (err) => console.error("  events:", err.message),
});

await store.resync();
subscriber.start();
if (!eventsOnly) store.startSync();
await Bun.sleep(1_000);

let checks = 0;
let drifted = 0;
const deadline = Date.now() + seconds * 1000;

console.log(
  `comparing mirror against live snapshots for ${seconds}s ` +
    `(${eventsOnly ? "events only — expected to drift" : "events + periodic sync"})\n`,
);

while (Date.now() < deadline) {
  await Bun.sleep(5_000);
  checks++;

  const { snapshot } = await client.rpc("session.snapshot", {});
  const truth = new Map(snapshot.agents.map((a) => [a.pane_id, a.agent_status]));

  // The dashboard reads status off PaneInfo, so that is what must be checked —
  // not the AgentInfo copy.
  const mirror = new Map(store.state.panes.map((p) => [p.pane_id, p.agent_status]));

  const wrong: string[] = [];
  for (const [paneId, actual] of truth) {
    const mirrored = mirror.get(paneId);
    if (mirrored !== actual) wrong.push(`${paneId}: mirror=${mirrored ?? "absent"} herdr=${actual}`);
  }

  if (wrong.length > 0) {
    drifted++;
    console.log(`  [${checks}] DRIFT — ${wrong.length} pane(s):`);
    for (const line of wrong) console.log(`        ${line}`);
  } else {
    console.log(`  [${checks}] in sync (${truth.size} agents)`);
  }
}

subscriber.stop();
store.stopSync();

console.log(
  `\n${drifted} of ${checks} checks drifted` +
    (drifted === 0 ? " — the mirror tracks herdr" : " — the mirror is not keeping up"),
);

// In --events-only mode drifting is the expected, demonstrated result.
process.exit(eventsOnly || drifted === 0 ? 0 : 1);
