/**
 * Captures parser fixtures from the live session.
 *
 * Writes `<status>__<pane>__{text,ansi}.txt` plus the matching `AgentInfo`, so
 * the parser suite is driven by screens herdr actually produced rather than by
 * screens we imagined. Read-only against herdr.
 *
 *   bun run server/scripts/capture-fixtures.ts              # 2 panes per status
 *   bun run server/scripts/capture-fixtures.ts wA:p1 w4:p2  # specific panes
 *
 * Captures contain real terminal content — see fixtures/README.md before
 * publishing this repository.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HerdrClient } from "../lib/herdr-client";

const PER_STATUS = 2;
const FIXTURES = join(import.meta.dir, "..", "fixtures");
mkdirSync(FIXTURES, { recursive: true });

const client = new HerdrClient();
await client.connect();

const { agents } = await client.rpc("agent.list", {});
const requested = process.argv.slice(2);

const selected = requested.length
  ? agents.filter((a) => requested.includes(a.pane_id))
  : Object.values(
      agents.reduce<Record<string, typeof agents>>((acc, a) => {
        (acc[a.agent_status] ??= []).push(a);
        return acc;
      }, {}),
    ).flatMap((group) => group.slice(0, PER_STATUS));

if (requested.length && selected.length !== requested.length) {
  const found = new Set(selected.map((a) => a.pane_id));
  const missing = requested.filter((id) => !found.has(id));
  console.error(`no agent in pane(s): ${missing.join(", ")}`);
  process.exit(1);
}

for (const agent of selected) {
  const slug = `${agent.agent_status}__${agent.pane_id.replace(":", "-")}`;

  for (const [format, stripAnsi] of [
    ["text", true],
    ["ansi", false],
  ] as const) {
    const { read } = await client.rpc("pane.read", {
      pane_id: agent.pane_id,
      source: "visible",
      format,
      strip_ansi: stripAnsi,
    });
    writeFileSync(join(FIXTURES, `${slug}__${format}.txt`), read.text);
  }

  writeFileSync(join(FIXTURES, `${slug}__meta.json`), `${JSON.stringify(agent, null, 2)}\n`);
  console.log(`  ${slug}  (${agent.agent ?? "?"} — ${agent.terminal_title_stripped ?? ""})`);
}

console.log(`\ncaptured ${selected.length} pane(s) to ${FIXTURES}`);
