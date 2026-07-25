/**
 * Measures what the poller actually costs the herdr server.
 *
 * The plan flags polling load as a real risk rather than a theoretical one:
 * ~27 panes read on a short interval is genuine work, and it lands on the same
 * process that is running the user's actual terminals. This measures the herdr
 * server's own CPU while idle, then under a watched-pane workload, and reports
 * the delta.
 *
 * Read-only with respect to herdr state. Run:
 *   bun run server/scripts/measure-poll-cost.ts [seconds]
 */
import { HerdrClient } from "../lib/herdr-client";
import { Poller } from "../lib/poller";
import { SessionStore } from "../lib/state";
import { TranscriptStore } from "../lib/transcript";

const WINDOW_SECONDS = Number(process.argv[2] ?? 20);

/** Cumulative CPU jiffies (utime + stime) for a pid, from /proc. */
async function cpuJiffies(pid: number): Promise<number> {
  const stat = await Bun.file(`/proc/${pid}/stat`).text();
  // The comm field can contain spaces and parens; everything after the last
  // ')' is positional, with utime/stime at offsets 11 and 12.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return Number(fields[11]) + Number(fields[12]);
}

async function herdrServerPid(): Promise<number> {
  const out = await new Response(Bun.spawn(["pgrep", "-f", "herdr server"]).stdout).text();
  const pid = Number(out.trim().split("\n")[0]);
  if (!Number.isFinite(pid)) throw new Error("could not find the `herdr server` process");
  return pid;
}

const clockTicks = 100; // _SC_CLK_TCK on Linux
const pid = await herdrServerPid();
console.log(`herdr server pid ${pid}, ${WINDOW_SECONDS}s windows\n`);

const client = new HerdrClient();
await client.connect();

const store = new SessionStore(client);
await store.resync();
const transcript = new TranscriptStore(":memory:");

const paneCount = store.state.panes.length;
const active = store.state.agents.filter(
  (a) => a.agent_status === "working" || a.agent_status === "blocked",
).length;
console.log(`${paneCount} panes, ${active} working/blocked\n`);

async function measure(label: string, run: () => Promise<void>): Promise<number> {
  const before = await cpuJiffies(pid);
  const startedAt = Date.now();
  await run();
  const elapsed = (Date.now() - startedAt) / 1000;
  const used = (await cpuJiffies(pid)) - before;
  const percent = (used / clockTicks / elapsed) * 100;
  console.log(`  ${label.padEnd(34)} ${percent.toFixed(2)}% CPU`);
  return percent;
}

// Baseline: herdr with no polling from us at all.
const baseline = await measure("baseline (poller stopped)", () => Bun.sleep(WINDOW_SECONDS * 1000));

// Realistic phone-in-pocket load: a client connected, nothing open.
const poller = new Poller(client, store, transcript);
let frames = 0;
poller.on("frame", () => frames++);
poller.on("error", (e) => console.error("    poller error:", e.message));
poller.start();
poller.setClientCount(1);

frames = 0;
const dashboardOnly = await measure("dashboard open, no pane watched", () =>
  Bun.sleep(WINDOW_SECONDS * 1000),
);
const dashboardFrames = frames;

// Heaviest realistic load: one pane open at the 400ms watched interval.
const target =
  store.state.agents.find((a) => a.agent_status === "working")?.pane_id ??
  store.state.panes[0]?.pane_id;
let unwatch = () => {};
if (target) unwatch = poller.watch(target);

frames = 0;
const watching = await measure(`watching ${target ?? "(none)"}`, () =>
  Bun.sleep(WINDOW_SECONDS * 1000),
);
const watchedFrames = frames;

unwatch();
poller.stop();
transcript.close();

console.log(`
frames emitted: ${dashboardFrames} (dashboard) / ${watchedFrames} (watching)
overhead vs baseline:
  dashboard only   ${(dashboardOnly - baseline).toFixed(2)} points
  one pane watched ${(watching - baseline).toFixed(2)} points
`);
