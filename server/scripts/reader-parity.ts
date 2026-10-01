/**
 * Compares Read with Screen for every agent pane in a herdr session, the way
 * the owner did when Reader showed a stale reply and no task list (October
 * 2026). Run it before a release, after updating an agent, and while an agent
 * is busy with a multi-step task, since that is when Screen draws the most:
 *
 *   bun run server/scripts/reader-parity.ts [pane_id …] [--show]
 *
 * Read-only: it reads screens and transcripts, the same as the app's own
 * Read and Screen tabs, and writes nothing to any pane. It prints pane ids,
 * agents and counts. `--show` also prints the Screen lines Read lacks, to
 * this terminal and nowhere else, for a person deciding what is wrong; that is
 * terminal content, so never redirect it into a file that is kept.
 *
 * Exit 1 when any pane disagrees.
 */
import { HerdrClient } from "../lib/herdr-client";
import { transcriptPage, transcriptSourceFor } from "../lib/conversation-summary";
import { compare, disagreement } from "../lib/reader-parity";
import { SessionStore } from "../lib/state";

const show = process.argv.includes("--show");
const wanted = new Set(process.argv.slice(2).filter(arg => !arg.startsWith("--")));

const client = new HerdrClient();
await client.connect();
const store = new SessionStore(client);
await store.resync();

let disagreed = 0;
for (const agent of store.state.agents) {
  if (wanted.size && !wanted.has(agent.pane_id)) continue;
  const pane = store.pane(agent.pane_id);
  if (!pane?.agent) continue;
  const { read } = await client.rpc("pane.read", { pane_id: pane.pane_id, source: "visible", format: "text", strip_ansi: true });
  const source = await transcriptSourceFor(pane, client);
  // A wide window: Screen can hold many short tool steps.
  const page = source ? await transcriptPage(pane.pane_id, source, pane.agent, { limit: 200 }) : null;
  const label = `${pane.pane_id.padEnd(8)} ${String(pane.agent).padEnd(8)} ${String(agent.agent_status).padEnd(8)}`;
  if (!page) {
    console.log(`${label} no transcript`);
    continue;
  }
  const parity = compare(read.text, pane.agent, page.log);
  const verdict = disagreement(parity);
  console.log(`${label} lines ${parity.found}/${parity.lines}  tasks ${parity.tasksFound}/${parity.tasks}  ${verdict ?? "agrees"}`);
  if (verdict) {
    disagreed++;
    if (show) for (const line of parity.missing) console.log(`           missing: ${line}`);
  }
}

console.log(disagreed ? `\n${disagreed} pane(s) where Read and Screen disagree.` : "\nRead agrees with Screen in every agent pane.");
process.exit(disagreed ? 1 : 0);
