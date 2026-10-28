import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configDirFromEnviron, processConfigDir } from "./claude-config";
import { conversationChoices, projectFolder } from "./claude-choice";
import { transcriptPage, transcriptSourceFor } from "./conversation-summary";

// Two accounts on one computer: the service runs with one folder, and the
// pane's Claude with another.
const root = mkdtempSync(join(tmpdir(), "shahi-claude-config-"));
const service = join(root, "service");
const account = join(root, "account");
mkdirSync(service, { recursive: true });
const previous = process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CONFIG_DIR = service;
afterAll(() => {
  if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

const SESSION = "55555555-5555-4555-8555-555555555555";
const OTHER = "66666666-6666-4666-8666-666666666666";
const CWD = "/home/me/work/reports";

function transcript(config: string, sessionId: string, text: string) {
  const dir = join(config, "projects", projectFolder(CWD));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, JSON.stringify({ type: "user", uuid: crypto.randomUUID(), message: { role: "user", content: text } }) + "\n");
  return realpathSync(path);
}

describe("reading CLAUDE_CONFIG_DIR from a process environment", () => {
  test("an absolute folder is taken, a relative or empty one is not", () => {
    expect(configDirFromEnviron(`HOME=/home/me\0CLAUDE_CONFIG_DIR=/home/me/.claude-work/\0`)).toBe("/home/me/.claude-work/");
    expect(configDirFromEnviron(`CLAUDE_CONFIG_DIR=/home/me/a/../.claude-work\0`)).toBe("/home/me/.claude-work");
    expect(configDirFromEnviron(`CLAUDE_CONFIG_DIR=.claude-work\0`)).toBeNull();
    expect(configDirFromEnviron(`CLAUDE_CONFIG_DIR=\0`)).toBeNull();
    expect(configDirFromEnviron(`HOME=/home/me\0XCLAUDE_CONFIG_DIR=/elsewhere\0`)).toBeNull();
  });

  test("a process that cannot be read gives no folder", async () => {
    const proc = join(root, "proc");
    mkdirSync(join(proc, "4242"), { recursive: true });
    writeFileSync(join(proc, "4242", "environ"), `CLAUDE_CONFIG_DIR=${account}\0`);
    expect(await processConfigDir(4242, proc)).toBe(account);
    expect(await processConfigDir(4343, proc)).toBeNull();
    expect(await processConfigDir(-1, proc)).toBeNull();
  });
});

// A real process started with another CLAUDE_CONFIG_DIR, standing in for the
// pane's Claude. Linux only: macOS stays on the service's folder.
describe.skipIf(process.platform !== "linux")("a pane whose Claude runs with another account's folder", () => {
  const child = Bun.spawn(["sleep", "60"], { env: { ...process.env, CLAUDE_CONFIG_DIR: account }, stdout: "ignore", stderr: "ignore" });
  afterAll(() => child.kill());
  const client = {
    rpc: async (method: string) => {
      if (method !== "pane.process_info") throw new Error(method);
      return { process_info: { foreground_processes: [{ pid: child.pid, name: "2.1.283", argv0: "claude", cwd: CWD }] } };
    },
  } as never;
  const pane = (session: string | null) => ({
    pane_id: "w9:p1", terminal_id: "term_cfg", agent: "claude", cwd: CWD,
    agent_session: session ? { agent: "claude", kind: "id", source: "herdr:claude", value: session } : null,
  }) as never;

  test("Reader is not empty when the conversation is not in the service's folder", async () => {
    const path = transcript(account, SESSION, "Reconcile the October invoices");
    expect(await transcriptSourceFor(pane(SESSION), client)).toBe(path);
    const page = await transcriptPage("w9:p1", path, "claude", { limit: 10 });
    expect(JSON.stringify(page?.log.messages)).toContain("Reconcile the October invoices");
  });

  test("the task list comes from the same folder as the conversation", async () => {
    const path = transcript(account, OTHER, "Plan the release");
    const tasks = join(account, "tasks", OTHER);
    mkdirSync(tasks, { recursive: true });
    writeFileSync(join(tasks, "1.json"), JSON.stringify({ id: "1", subject: "Tag the release", status: "pending" }));
    expect(await transcriptSourceFor(pane(OTHER), client)).toBe(path);
    expect((await transcriptPage("w9:p1", path, "claude", { limit: 10 }))?.log.tasks).toEqual([{ id: "1", subject: "Tag the release", status: "pending" }]);
  });

  test("a copy in the service's folder is not what this pane shows", async () => {
    transcript(service, SESSION, "The service account's copy");
    expect(await transcriptSourceFor(pane(SESSION), client)).toBe(transcript(account, SESSION, "Reconcile the October invoices"));
  });

  test("the conversations offered to choose from are this account's", async () => {
    const choices = await conversationChoices(client, pane(null), new Set());
    expect(choices.map((choice) => choice.sessionId).sort()).toEqual([SESSION, OTHER]);
    expect(JSON.stringify(choices)).not.toContain("service account");
  });
});
