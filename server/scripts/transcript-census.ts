/**
 * Counts every shape the agents on this computer have written to the
 * transcripts Reader reads, and fails on any that `transcript-shapes.ts` has
 * no decision for. Run it before a release and after updating an agent:
 *
 *   bun run server/scripts/transcript-census.ts [--source]
 *
 * `--source` also reads the installed Codex release's own list of
 * conversation items (`TurnItem` in codex-rs/protocol/src/items.rs, at the
 * `rust-v<version>` tag), so a new item fails here before any rollout holds
 * one. Claude Code's repository does not hold its implementation, so its side
 * is checked against transcripts, and against Screen by reader-parity.ts.
 *
 * Read-only. Prints shape names and counts, never content.
 */
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeConfigDir } from "../lib/session-log";
import { CLAUDE_SHAPES, CODEX_SHAPES, claudeShapes, codexShapes, unclassified, type Decision } from "../lib/transcript-shapes";

async function census(files: string[], shapes: (row: unknown) => string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const file of files) {
    for (const line of (await readFile(file, "utf8")).split("\n")) {
      if (!line.trim()) continue;
      let row: unknown;
      try { row = JSON.parse(line); } catch { continue; }
      for (const key of shapes(row)) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/** Main transcripts only: subagent and workflow transcripts are not what Reader reads. */
async function claudeFiles(): Promise<string[]> {
  const root = join(claudeConfigDir(), "projects");
  const files: string[] = [];
  for (const project of await readdir(root).catch(() => [])) {
    for (const name of await readdir(join(root, project)).catch(() => [])) {
      if (/^[0-9a-f-]{36}\.jsonl$/i.test(name)) files.push(join(root, project, name));
    }
  }
  return files;
}

async function codexFiles(): Promise<string[]> {
  const root = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
  const entries = await readdir(root, { recursive: true }).catch(() => [] as string[]);
  return entries.filter(name => /rollout-[^/]*\.jsonl$/.test(name)).map(name => join(root, name));
}

/** The `TurnItem` variants of the installed Codex release, or null when it cannot be read. */
async function codexSourceItems(): Promise<{ version: string; items: string[] } | null> {
  const proc = Bun.spawn(["codex", "--version"], { stdout: "pipe", stderr: "ignore" });
  const version = (await new Response(proc.stdout).text()).match(/(\d+\.\d+\.\d+)/)?.[1];
  if (!version) return null;
  const res = await fetch(`https://raw.githubusercontent.com/openai/codex/rust-v${version}/codex-rs/protocol/src/items.rs`);
  if (!res.ok) return null;
  const body = (await res.text()).match(/pub enum TurnItem \{([\s\S]*?)\n\}/)?.[1] ?? "";
  const items = [...body.matchAll(/^\s+([A-Z]\w*)\(/gm)].map(match => match[1]!);
  return items.length ? { version, items } : null;
}

function report(name: string, files: number, counts: Map<string, number>, table: Record<string, Decision>): number {
  console.log(`\n${name}: ${files} transcripts`);
  for (const [key, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${String(count).padStart(7)}  ${key.padEnd(44)} ${table[key]?.handling ?? "UNCLASSIFIED"}`);
  }
  const missing = unclassified(counts, table);
  for (const [key, count] of missing) console.log(`  unclassified: ${key} (${count})`);
  return missing.length;
}

let failures = 0;
const claude = await claudeFiles();
failures += report("Claude Code", claude.length, await census(claude, claudeShapes), CLAUDE_SHAPES);
const codex = await codexFiles();
failures += report("Codex", codex.length, await census(codex, codexShapes), CODEX_SHAPES);

if (process.argv.includes("--source")) {
  const source = await codexSourceItems();
  if (!source) {
    console.log("\nCodex source: could not read the installed release's TurnItem list");
    failures++;
  } else {
    const missing = source.items.filter(item => !(`item:${item}` in CODEX_SHAPES));
    console.log(`\nCodex ${source.version} source: ${source.items.length} conversation items, ${missing.length} unclassified`);
    for (const item of missing) console.log(`  unclassified: item:${item}`);
    failures += missing.length;
  }
}

if (failures) {
  console.log(`\n${failures} shape(s) without a decision. For each, compare Read with Screen while an agent writes it,`);
  console.log("then add it to server/lib/transcript-shapes.ts as shown, state, followed or dropped, with the reason.");
  process.exit(1);
}
console.log("\nEvery shape has a decision.");
