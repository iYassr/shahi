/**
 * Runs the prompt parser across every pane in the live session and cross-checks
 * it against herdr's own `agent_status`.
 *
 * The fixture suite covers six screens; this covers whatever the session
 * actually holds right now, which is where false positives show up. A false
 * positive matters more than a miss: it would render answer buttons on an agent
 * that is not waiting, and a tap would inject a stray keystroke into a live
 * session.
 *
 * Read-only. Run: bun run server/scripts/check-parser-live.ts
 */
import { HerdrClient } from "../lib/herdr-client";
import { parsePrompt } from "../lib/prompt-parser";

const client = new HerdrClient();
await client.connect();

const { snapshot } = await client.rpc("session.snapshot", {});
const statusOf = new Map(snapshot.agents.map((a) => [a.pane_id, a.agent_status]));

let falsePositives = 0;
let misses = 0;
let hits = 0;

for (const pane of snapshot.panes) {
  const { read } = await client.rpc("pane.read", {
    pane_id: pane.pane_id,
    source: "visible",
    format: "text",
    strip_ansi: true,
  });

  const parsed = parsePrompt(read.text);
  const status = statusOf.get(pane.pane_id) ?? "(no agent)";
  const blocked = status === "blocked";

  if (parsed && blocked) {
    hits++;
    console.log(`  HIT      ${pane.pane_id} [${status}]`);
    console.log(`           Q: ${parsed.question}`);
    for (const o of parsed.options) {
      console.log(`           ${o.selected ? "❯" : " "} ${o.index}. ${o.label}`);
    }
  } else if (parsed && !blocked) {
    falsePositives++;
    console.log(`  FALSE+   ${pane.pane_id} [${status}] parsed: ${parsed.question.slice(0, 80)}`);
    for (const o of parsed.options) console.log(`           ${o.index}. ${o.label.slice(0, 70)}`);
  } else if (!parsed && blocked) {
    misses++;
    console.log(`  MISS     ${pane.pane_id} [${status}] — blocked but no prompt parsed`);
    console.log(read.text.split("\n").slice(-12).join("\n"));
  }
}

console.log(
  `\n${snapshot.panes.length} panes: ${hits} parsed prompt(s), ` +
    `${falsePositives} false positive(s), ${misses} miss(es)`,
);

// A miss degrades to the raw terminal view, which is acceptable. A false
// positive is not.
process.exit(falsePositives === 0 ? 0 : 1);
