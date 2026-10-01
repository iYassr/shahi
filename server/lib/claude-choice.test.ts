import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { choiceHeld, chooseConversation, chosenSession, conversationChoices, forgetChoice, projectFolder, unsavedSession } from "./claude-choice";

const root = mkdtempSync(join(tmpdir(), "shahi-claude-choice-"));
const previous = process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CONFIG_DIR = root;
afterAll(() => {
  if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

const CWD = "/Users/me/.herdr/worktrees/reports.q3";
const OLDER = "11111111-1111-4111-8111-111111111111";
const NEWER = "22222222-2222-4222-8222-222222222222";
const RECORDED = "33333333-3333-4333-8333-333333333333";
const ELSEWHERE = "44444444-4444-4444-8444-444444444444";
const PID = 4242;

const user = (text: string) => JSON.stringify({ type: "user", uuid: crypto.randomUUID(), message: { role: "user", content: text } });
const agent = (text: string) => JSON.stringify({ type: "assistant", uuid: crypto.randomUUID(), message: { role: "assistant", content: [{ type: "text", text }] } });

function transcript(sessionId: string, rows: string[], ageSeconds: number, folder = projectFolder(CWD)) {
  const dir = join(root, "projects", folder);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, rows.join("\n") + "\n");
  const at = Date.now() / 1000 - ageSeconds;
  utimesSync(path, at, at);
}

let processes: { pid: number; name?: string; argv0?: string; cwd?: string }[] = [];
let herdrDown = false;
const client = {
  rpc: async (method: string) => {
    if (herdrDown) throw new Error("herdr is not answering");
    if (method !== "pane.process_info") throw new Error(method);
    return { process_info: { foreground_processes: processes } };
  },
} as never;
const pane = (over: Record<string, unknown> = {}) =>
  ({ pane_id: "w1:p1", terminal_id: "term_a", agent: "claude", agent_session: null, cwd: CWD, ...over }) as never;

beforeEach(() => {
  rmSync(join(root, "projects"), { recursive: true, force: true });
  rmSync(join(root, "sessions"), { recursive: true, force: true });
  rmSync(join(root, "jobs"), { recursive: true, force: true });
  forgetChoice("w1:p1");
  herdrDown = false;
  // A native install: named after its version, argv0 claude.
  processes = [{ pid: PID, name: "2.1.283", argv0: "claude", cwd: CWD }];
  transcript(OLDER, [user("Summarise the quarterly report"), agent("Here is the summary.")], 3_600);
  transcript(NEWER, [user("Fix the flaky test"), agent("Fixed it.")], 60);
  transcript(RECORDED, [user("Draft the invoice email"), agent("Draft below.")], 600);
  transcript(ELSEWHERE, [user("Another project")], 10, projectFolder("/Users/me/other"));
});

describe("choosing a conversation herdr cannot identify", () => {
  test("Claude's folder name for a path turns every other character into a dash", () => {
    expect(projectFolder("/Users/yasserdo/.herdr/worktrees/shahi")).toBe("-Users-yasserdo--herdr-worktrees-shahi");
    expect(projectFolder("/private/tmp/shahi-agent-audit.r1WWJn/work")).toBe("-private-tmp-shahi-agent-audit-r1WWJn-work");
  });

  // The TestFlight report: an existing Claude conversation, no session from
  // herdr, and Reader empty.
  test("an existing conversation is offered from the folder Claude runs in, newest first, with what was asked and said", async () => {
    const choices = await conversationChoices(client, pane(), new Set());
    expect(choices.map((c) => c.sessionId)).toEqual([NEWER, RECORDED, OLDER]);
    expect(choices[2]).toMatchObject({ firstPrompt: "Summarise the quarterly report", lastMessage: "Here is the summary.", likely: false });
  });

  test("the one Claude's own process record names comes first, marked likely, but is not chosen", async () => {
    mkdirSync(join(root, "sessions"), { recursive: true });
    writeFileSync(join(root, "sessions", `${PID}.json`), JSON.stringify({ pid: PID, sessionId: RECORDED }));
    const choices = await conversationChoices(client, pane(), new Set());
    expect(choices.map((c) => [c.sessionId, c.likely])).toEqual([[RECORDED, true], [NEWER, false], [OLDER, false]]);
    expect(choiceHeld("w1:p1")).toBeNull();
  });

  test("a process that parked its conversation as a background job hints at the parked one", async () => {
    mkdirSync(join(root, "sessions"), { recursive: true });
    writeFileSync(join(root, "sessions", `${PID}.json`), JSON.stringify({ pid: PID, sessionId: NEWER, parkedJobId: OLDER.slice(0, 8) }));
    mkdirSync(join(root, "jobs", OLDER.slice(0, 8)), { recursive: true });
    writeFileSync(join(root, "jobs", OLDER.slice(0, 8), "state.json"), JSON.stringify({ sessionId: OLDER }));
    const choices = await conversationChoices(client, pane(), new Set());
    expect(choices.map((c) => [c.sessionId, c.likely])).toEqual([[OLDER, true], [NEWER, false], [RECORDED, false]]);
    // A job whose state cannot be read hints at nothing: the record's own session is the stale one.
    rmSync(join(root, "jobs"), { recursive: true, force: true });
    expect((await conversationChoices(client, pane(), new Set())).some((c) => c.likely)).toBe(false);
  });

  test("conversations other panes hold are not offered, and neither is anything once herdr knows the session", async () => {
    expect((await conversationChoices(client, pane(), new Set([NEWER]))).map((c) => c.sessionId)).toEqual([RECORDED, OLDER]);
    expect(await conversationChoices(client, pane({ agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: NEWER } }), new Set())).toEqual([]);
  });

  test("no Claude process, or two, offers nothing rather than a guess at whose folder it is", async () => {
    processes = [{ pid: 1, name: "zsh" }];
    expect(await conversationChoices(client, pane(), new Set())).toEqual([]);
    processes = [{ pid: 1, name: "claude", cwd: CWD }, { pid: 2, name: "claude", cwd: CWD }];
    expect(await conversationChoices(client, pane(), new Set())).toEqual([]);
  });

  test("a choice is honoured only if it was offered", async () => {
    expect(await chooseConversation(client, pane(), ELSEWHERE, new Set())).toBe(false);
    expect(await chooseConversation(client, pane(), NEWER, new Set([NEWER]))).toBe(false);
    expect(await chooseConversation(client, pane(), "../../etc/passwd", new Set())).toBe(false);
    expect(await chooseConversation(client, pane(), OLDER, new Set())).toBe(true);
    expect(await chosenSession(client, pane())).toBe(OLDER);
  });

  test("a leaf symlink outside history never exposes a preview", async () => {
    const outside = join(root, `${OLDER}.jsonl`);
    writeFileSync(outside, user("Outside history must stay private") + "\n");
    const path = join(root, "projects", projectFolder(CWD), `${OLDER}.jsonl`);
    rmSync(path);
    symlinkSync(outside, path);
    expect((await conversationChoices(client, pane(), new Set())).map((c) => c.sessionId)).not.toContain(OLDER);
    expect(await chooseConversation(client, pane(), OLDER, new Set())).toBe(false);
  });

  test("a project symlink outside history never exposes previews", async () => {
    const outside = join(root, "outside-project");
    mkdirSync(outside);
    writeFileSync(join(outside, `${OLDER}.jsonl`), user("Outside project must stay private") + "\n");
    const project = join(root, "projects", projectFolder(CWD));
    rmSync(project, { recursive: true });
    symlinkSync(outside, project);
    expect(await conversationChoices(client, pane(), new Set())).toEqual([]);
    expect(await chooseConversation(client, pane(), OLDER, new Set())).toBe(false);
  });

  test("an alias for a different session never labels its preview as this session", async () => {
    const project = join(root, "projects", projectFolder(CWD));
    rmSync(join(project, `${OLDER}.jsonl`));
    symlinkSync(join(project, `${NEWER}.jsonl`), join(project, `${OLDER}.jsonl`));
    expect((await conversationChoices(client, pane(), new Set())).map((c) => c.sessionId)).toEqual([NEWER, RECORDED]);
    expect(await chooseConversation(client, pane(), OLDER, new Set())).toBe(false);
  });

  test("two distinct copies of a session are not offered when Reader cannot choose one", async () => {
    transcript(OLDER, [user("A conflicting copy")], 1, projectFolder("/Users/me/duplicate"));
    expect((await conversationChoices(client, pane(), new Set())).map((c) => c.sessionId)).not.toContain(OLDER);
    expect(await chooseConversation(client, pane(), OLDER, new Set())).toBe(false);
  });

  test("a directory alias of the same canonical history stays readable", async () => {
    symlinkSync(join(root, "projects", projectFolder(CWD)), join(root, "projects", "alias"));
    expect((await conversationChoices(client, pane(), new Set())).map((c) => c.sessionId)).toEqual([NEWER, RECORDED, OLDER]);
    expect(await chooseConversation(client, pane(), OLDER, new Set())).toBe(true);
  });

  // Found on an iPhone, October 2026: a new Claude at its folder-trust
  // dialog has reported no session (its hooks wait for trust), and Reader
  // said it "started before Shahi could identify it", offering old ones.
  // Claude 2.1.286 has already recorded its new session there, unsaved.
  describe("a new Claude that has saved nothing yet", () => {
    const FRESH = "55555555-5555-4555-8555-555555555555";
    const record = (sessionId: string) => {
      mkdirSync(join(root, "sessions"), { recursive: true });
      writeFileSync(join(root, "sessions", `${PID}.json`), JSON.stringify({ pid: PID, sessionId }));
    };

    test("is new rather than unidentified, and is offered no old conversation", async () => {
      record(FRESH);
      expect(await unsavedSession(client, pane())).toBe(true);
      expect(await conversationChoices(client, pane(), new Set())).toEqual([]);
      expect(await chooseConversation(client, pane(), OLDER, new Set())).toBe(false);
    });

    test("is not, once its recorded session has a transcript", async () => {
      record(RECORDED);
      expect(await unsavedSession(client, pane())).toBe(false);
      expect((await conversationChoices(client, pane(), new Set())).length).toBeGreaterThan(0);
    });

    test("is not when Claude kept no record, or herdr does not answer: the old answer stands", async () => {
      expect(await unsavedSession(client, pane())).toBe(false);
      record(FRESH);
      herdrDown = true;
      expect(await unsavedSession(client, pane())).toBe(false);
    });
  });

  test("a choice holds while that Claude runs there, including through a tool it runs", async () => {
    await chooseConversation(client, pane(), OLDER, new Set());
    processes = [...processes, { pid: 999, name: "bash" }];
    expect(await chosenSession(client, pane())).toBe(OLDER);
    herdrDown = true;
    expect(await chosenSession(client, pane())).toBeNull();
    herdrDown = false;
    expect(await chosenSession(client, pane())).toBe(OLDER);
  });

  test("a choice ends with its Claude process, its terminal, or the hook's own report", async () => {
    await chooseConversation(client, pane(), OLDER, new Set());
    processes = [{ pid: PID + 1, name: "claude", cwd: CWD }];
    expect(await chosenSession(client, pane())).toBeNull();
    expect(choiceHeld("w1:p1")).toBeNull();

    processes = [{ pid: PID, name: "claude", cwd: CWD }];
    await chooseConversation(client, pane(), OLDER, new Set());
    expect(await chosenSession(client, pane({ terminal_id: "term_b" }))).toBeNull();

    await chooseConversation(client, pane(), OLDER, new Set());
    expect(await chosenSession(client, pane({ agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: NEWER } }))).toBeNull();
    expect(choiceHeld("w1:p1")).toBeNull();
  });
});
