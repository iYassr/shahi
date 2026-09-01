/**
 * Guards the thing this package exists to fix.
 *
 * Nine wire types were previously declared twice — once by the server module
 * that produced them, once by hand in the web client — with nothing enforcing
 * that the two agreed. `activity` and `cwdPath` each went missing on one side
 * for a while as a result.
 *
 * TypeScript catches a *mismatched* redeclaration once both sides import the
 * contract. It does not catch someone quietly declaring a fresh local copy,
 * which is exactly how the drift started. This does.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

/** Names that must only ever be declared in shared/src/index.ts. */
const CONTRACT = [
  "AgentStatus",
  "PromptOption",
  "ParsedPrompt",
  "Activity",
  "PaneFrame",
  "DashboardPane",
  "Space",
  "SpaceTab",
  "Session",
  "LogBlock",
  "LogMessage",
  "SessionLog",
  "TranscriptLine",
  "DirEntry",
  "DirListing",
  "StoredUpload",
  "InstalledAgent",
  "SocketMessage",
  "StatusChange",
  "ServerInfo",
  "PromptReceipt",
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    // herdr-schema.ts is generated from herdr's own API schema and legitimately
    // declares its own AgentStatus — that is herdr's type, which the contract
    // happens to mirror, not a hand copy of ours.
    else if (
      /\.tsx?$/.test(entry) &&
      !/\.test\.tsx?$/.test(entry) &&
      entry !== "herdr-schema.ts"
    ) {
      out.push(path);
    }
  }
  return out;
}

describe("the wire contract is declared once", () => {
  const files = [
    ...sourceFiles(join(ROOT, "server", "lib")),
    ...sourceFiles(join(ROOT, "web", "src")),
  ];

  test("there are files to check", () => {
    expect(files.length).toBeGreaterThan(15);
  });

  test.each(CONTRACT)("%s is not re-declared outside shared", (name) => {
    const offenders = files.filter((path) => {
      const source = readFileSync(path, "utf8");
      // `export type X = ...` re-exporting the import is fine; a fresh
      // `interface X {` or a union body is not.
      return (
        new RegExp(`^\\s*(export\\s+)?interface\\s+${name}\\s*[<{]`, "m").test(source) ||
        new RegExp(`^\\s*(export\\s+)?type\\s+${name}\\s*=\\s*$`, "m").test(source) ||
        new RegExp(`^\\s*(export\\s+)?type\\s+${name}\\s*=\\s*[^;\\n]*\\|`, "m").test(source)
      );
    });

    expect(offenders.map((p) => p.slice(ROOT.length + 1))).toEqual([]);
  });
});
