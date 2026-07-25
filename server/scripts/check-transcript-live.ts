/**
 * Verifies the scrollback recorder against a real, actively-working agent.
 *
 * The alignment heuristic in `linesScrolledOff` is the risky part of the whole
 * transcript idea: Claude Code repaints its screen constantly (spinners, token
 * counters, an editable composer), and a heuristic tuned only against synthetic
 * screens could plausibly never fire on the real thing — or fire constantly and
 * fill the buffer with near-duplicate frames. Neither shows up in unit tests.
 *
 * Read-only against herdr; the transcript is written to an in-memory database.
 *
 * Run: bun run server/scripts/check-transcript-live.ts [pane_id] [seconds]
 */
import { HerdrClient } from "../lib/herdr-client";
import { Poller } from "../lib/poller";
import { SessionStore } from "../lib/state";
import { TranscriptStore } from "../lib/transcript";

const client = new HerdrClient();
await client.connect();

const store = new SessionStore(client);
await store.resync();

const requested = process.argv[2];
const seconds = Number(process.argv[3] ?? 45);

const target =
  requested ??
  store.state.agents.find((a) => a.agent_status === "working")?.pane_id ??
  store.state.agents.find((a) => a.agent_status === "blocked")?.pane_id ??
  store.state.panes[0]?.pane_id;

if (!target) {
  console.error("no panes available");
  process.exit(1);
}

const status = store.pane(target)?.agent_status ?? "?";
console.log(`watching ${target} [${status}] for ${seconds}s`);
if (status !== "working") {
  console.log("note: a working agent exercises this far harder than an idle one");
}

const transcript = new TranscriptStore(":memory:");
const poller = new Poller(client, store, transcript);

let frames = 0;
// "Nothing recorded" has two very different causes, and the first run of this
// script could not tell them apart: the pane may never have scrolled (correct
// to record nothing), or it scrolled and alignment failed (a real bug). Classify
// each changed frame by whether the *top* of the screen moved.
let scrollCandidates = 0;
let repaintOnly = 0;
let previous: string[] | undefined;

poller.on("frame", (f) => {
  if (f.paneId !== target) return;
  frames++;

  const lines = f.text.split("\n").map((l) => l.trimEnd());
  if (previous) {
    let head = 0;
    while (head < Math.min(previous.length, lines.length) && previous[head] === lines[head]) head++;
    // A screen whose first lines still match did not scroll; only its volatile
    // lower region was repainted.
    if (head < 3) scrollCandidates++;
    else repaintOnly++;
  }
  previous = lines;
});
poller.on("error", (e) => console.error("  poller error:", e.message));

poller.start();
poller.setClientCount(1);
const unwatch = poller.watch(target);

await Bun.sleep(seconds * 1000);

unwatch();
poller.stop();

const recorded = transcript.tail(target, 2_000);
console.log(`\n${frames} changed frames, ${recorded.length} lines committed to history`);
console.log(`  ${repaintOnly} repaint-only (spinner/counter), ${scrollCandidates} moved the top of the screen`);

if (recorded.length > 0) {
  const blank = recorded.filter((l) => l.text.trim() === "").length;
  const unique = new Set(recorded.map((l) => l.text)).size;
  console.log(`  ${unique} distinct, ${blank} blank`);
  console.log("\nlast 12 recorded lines:");
  for (const line of recorded.slice(-12)) {
    console.log(`  ${String(line.seq).padStart(4)} | ${line.text.slice(0, 110)}`);
  }
} else if (scrollCandidates === 0) {
  console.log("\nnothing recorded, and nothing scrolled — correct. Re-run while an agent is");
  console.log("actively emitting output; a spinning agent repaints without scrolling.");
} else {
  console.log(`\nPROBLEM: ${scrollCandidates} frame(s) moved the top of the screen but none aligned.`);
  process.exit(1);
}

transcript.close();
