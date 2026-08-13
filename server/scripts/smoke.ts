/**
 * End-to-end check of the socket client against a live herdr server.
 *
 * Read-only: every method called here is a query. Nothing is sent to any pane.
 *
 * Run: bun run server/scripts/smoke.ts
 */
import { HerdrClient, HerdrSubscriber, type AnyEvent } from "../lib/herdr-client";
import { HERDR_PROTOCOL } from "../lib/herdr-schema";

const client = new HerdrClient();
let failures = 0;

function check(label: string, ok: boolean, detail: string) {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label} — ${detail}`);
  if (!ok) failures++;
}

console.log(`socket: ${client.socketPath}\n`);

// 1. Handshake and protocol pin.
const { version, protocol } = await client.connect();
check("ping", protocol === HERDR_PROTOCOL, `herdr ${version}, protocol ${protocol}`);

// 2. Whole-session snapshot.
const { snapshot } = await client.rpc("session.snapshot", {});
check(
  "session.snapshot",
  snapshot.workspaces.length > 0 && snapshot.panes.length > 0,
  `${snapshot.workspaces.length} workspaces, ${snapshot.tabs.length} tabs, ` +
    `${snapshot.panes.length} panes, ${snapshot.agents.length} agents`,
);

// 3. Agent statuses — the signal the whole dashboard is built on.
const byStatus = new Map<string, number>();
for (const a of snapshot.agents) byStatus.set(a.agent_status, (byStatus.get(a.agent_status) ?? 0) + 1);
check(
  "agent statuses",
  snapshot.agents.length > 0,
  [...byStatus].map(([s, n]) => `${s}=${n}`).join(" "),
);

// 4. Pane geometry — xterm.js is sized from this.
const layout = snapshot.layouts[0];
check(
  "layout geometry",
  layout !== undefined && layout.panes.length > 0,
  layout ? `${layout.tab_id} area ${layout.area.width}x${layout.area.height}` : "no layouts",
);

// 5. Reading a pane, in both the stripped and raw forms the UI needs.
const readable = snapshot.panes[0];
if (!readable) {
  check("pane.read", false, "no panes to read");
} else {
  const text = await client.rpc("pane.read", {
    pane_id: readable.pane_id,
    source: "visible",
    format: "text",
    strip_ansi: true,
  });
  const ansi = await client.rpc("pane.read", {
    pane_id: readable.pane_id,
    source: "visible",
    format: "ansi",
    strip_ansi: false,
  });
  check(
    "pane.read",
    text.read.text.length > 0 && ansi.read.text.includes("["),
    `${readable.pane_id}: ${text.read.text.length}B text, ${ansi.read.text.length}B ansi ` +
      `(escape sequences ${ansi.read.text.includes("[") ? "present" : "MISSING"})`,
  );
}

// 6. Sequential RPCs must each get their own connection. If pooling ever crept
//    in, this is where it would surface as EPIPE.
const seq = await Promise.all([
  client.rpc("workspace.list", {}),
  client.rpc("pane.list", { workspace_id: null }),
  client.rpc("agent.list", {}),
]);
check(
  "concurrent RPCs",
  seq.length === 3,
  "workspace.list + pane.list + agent.list all answered",
);

// 7. The subscription connection must stay open and deliver events.
const events: AnyEvent[] = [];
let resyncs = 0;
const sub = new HerdrSubscriber({
  onEvent: (e) => events.push(e),
  onResync: () => void resyncs++,
  onError: (e) => console.error("  subscriber error:", e.message),
});
sub.start();
await Bun.sleep(6_000);
sub.stop();

check("events.subscribe ack", resyncs === 1, `${resyncs} resync callback(s)`);
check(
  "event stream",
  events.length > 0,
  `${events.length} events in 6s (${[...new Set(events.map((e) => e.event))].slice(0, 6).join(", ")})`,
);

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
