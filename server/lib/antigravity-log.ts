/** Antigravity CLI's documented persistent transcript, measured on 1.2.11.
 * https://antigravity.google/docs/hooks/ names the path. The CLI's presence lock
 * binds a running process to its conversation when herdr has no session hook.
 * Working-directory caches and database recency never establish ownership. */
import { mkdtemp, readdir, readFile, readlink, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { LogBlock } from "@shahi/shared";
import type { HerdrClient } from "./herdr-client";
import { realPath } from "./real-path";
import { inTranscript, isRecord, readWindow, type LogMessage, type SessionLog } from "./session-log";

const ROOT = join(homedir(), ".gemini", "antigravity-cli");
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const RESULT_LIMIT = 2_000;
const TEXT_LIMIT = 64 * 1024;
const BLOCK_BYTES = 384 * 1024;
const CALL_LIMIT = 256;
const LOG_TAIL = [".system_generated", "logs", "transcript.jsonl"];

export async function findAntigravityTranscript(sessionId: string, root = ROOT): Promise<string | null> {
  if (!UUID.test(sessionId)) return null;
  try {
    const brain = await realPath(join(root, "brain"));
    const path = await realPath(join(brain, sessionId, ...LOG_TAIL));
    if (path !== join(brain, sessionId, ...LOG_TAIL) || !(await stat(path)).isFile()) return null;
    return path;
  } catch { return null; }
}

/** A presence lock belongs to the active conversation. A database can stay open
 * for a previous conversation or a child, so it deliberately does not count. */
export function antigravitySessionFromPresence(path: string, root = ROOT): string | null {
  const parts = relative(resolve(root), resolve(path)).split("/");
  if (parts.length !== 2 || parts[0] !== "presence" || !parts[1]!.endsWith(".lock")) return null;
  const id = parts[1]!.slice(0, -5);
  return UUID.test(id) ? id : null;
}

/** More than one current lock is ambiguous, including multiple foreground agy
 * processes. The caller waits for a reported session instead of picking one. */
export function antigravitySessionFromFiles(paths: string[], root = ROOT): string | null {
  const ids = new Set(paths.map(path => antigravitySessionFromPresence(path, root)).filter((id): id is string => id !== null));
  return ids.size === 1 ? [...ids][0]! : null;
}

async function openFiles(pid: number): Promise<string[]> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return [];
  if (process.platform !== "darwin") {
    try {
      return await Promise.all((await readdir(`/proc/${pid}/fd`)).map(fd => readlink(`/proc/${pid}/fd/${fd}`).catch(() => "")));
    } catch { return []; }
  }
  let scratch: string | undefined;
  try {
    scratch = await mkdtemp(join(tmpdir(), "shahi-antigravity-"));
    const output = join(scratch, "files");
    // Detached macOS services can have invalid pipes; keep paths in a private
    // temporary file, never service logs, just as the Codex/Cursor readers do.
    const child = Bun.spawn(["/bin/sh", "-c", 'exec /usr/sbin/lsof -a -p "$1" -Fn > "$2"', "shahi-agy", String(pid), output], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), 2_000);
    try { if (await child.exited !== 0) return []; } finally { clearTimeout(timer); }
    return (await readFile(output, "utf8")).split("\n").filter(line => line.startsWith("n")).map(line => line.slice(1));
  } catch { return []; }
  finally { if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {}); }
}

export async function antigravityTranscriptFor(client: HerdrClient, paneId: string, sessionId?: string | null): Promise<string | null> {
  // The caller supplies only agentSessionOf(pane), which refuses another agent's
  // retained report. A valid report with no file must not bind to another ID.
  if (sessionId) return findAntigravityTranscript(sessionId);
  try {
    const reply = await client.rpc("pane.process_info", { pane_id: paneId }) as { process_info?: { foreground_processes?: { pid: number; name?: string }[] } };
    const paths: string[] = [];
    for (const process of reply.process_info?.foreground_processes ?? []) {
      if (process.name !== "agy") continue;
      paths.push(...await openFiles(process.pid));
    }
    const id = antigravitySessionFromFiles(paths);
    return id ? findAntigravityTranscript(id) : null;
  } catch { return null; }
}

/** User records also contain model-facing metadata and settings changes. */
export function antigravityUserText(content: string): string {
  const request = /^\s*<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>(?:\s|$)/.exec(content);
  if (request) return request[1]!.trim();
  // Plain authored input is a supported older shape. Unknown tagged envelopes
  // are not attributed to the human as though they had typed model context.
  return /^\s*</.test(content) ? "" : content.trim();
}

/** 1.2.11 serialises each tool argument separately as JSON, even string values. */
function argumentsOf(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, argument]) => {
    if (typeof argument !== "string") return [key, argument];
    try { return [key, JSON.parse(argument)]; } catch { return [key, argument]; }
  }));
}

function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function cut(value: string, limit: number): string {
  const end = limit > 0 && /[\uD800-\uDBFF]/.test(value.charAt(limit - 1)) ? limit - 1 : limit;
  return value.slice(0, end);
}
function excerpt(value: string, limit: number): string {
  return value.length > limit ? cut(value, limit) + "…" : value;
}
function truncated(row: Record<string, unknown>, field: string): boolean {
  return Array.isArray(row.truncated_fields) && row.truncated_fields.includes(field);
}
function summaryOf(args: Record<string, unknown>): string {
  const value = ["CommandLine", "TargetFile", "AbsolutePath", "DirectoryPath", "SearchPath", "Query", "query", "Url", "Description", "toolSummary", "Prompt"]
    .map(key => text(args[key])).find(Boolean) ?? "";
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? cut(flat, 120) + "…" : flat;
}
function fileOf(args: Record<string, unknown>): { file?: { path: string; name: string } } {
  const path = [args.TargetFile, args.AbsolutePath].find(value => typeof value === "string" && value.length <= 4096 && isAbsolute(value));
  return typeof path === "string" ? { file: { path, name: excerpt(basename(path), 256) } } : {};
}
function questionsOf(name: string, args: Record<string, unknown>): { questions?: { text: string; options: { label: string; description?: string }[] }[]; shortened: boolean } {
  if (name !== "ask_question" || !Array.isArray(args.questions)) return { shortened: false };
  let shortened = args.questions.length > 8;
  const questions = args.questions.slice(0, 8).filter(isRecord).map(question => {
    const rawOptions = Array.isArray(question.options) ? question.options : [];
    shortened ||= text(question.question).length > 1024 || rawOptions.length > 16;
    return {
      text: excerpt(text(question.question), 1024),
      options: rawOptions.slice(0, 16).flatMap(option => {
        if (typeof option === "string") { shortened ||= option.length > 128; return option ? [{ label: excerpt(option, 128) }] : []; }
        if (!isRecord(option) || typeof option.label !== "string" || !option.label) return [];
        shortened ||= option.label.length > 128 || text(option.description).length > 256;
        return [{ label: excerpt(option.label, 128), ...(typeof option.description === "string" ? { description: excerpt(option.description, 256) } : {}) }];
      }),
    };
  }).filter(question => question.text && question.options.length);
  return { ...(questions.length ? { questions } : {}), shortened };
}

/** There is no call ID in the exported transcript. Pair only the measured
 * singular call immediately followed by its MODEL/GENERIC step at index+1.
 * Multiple/truncated calls, missing steps and unknown sources never acquire guessed output. */
export function normaliseAntigravity(rows: Record<string, unknown>[]): LogMessage[] {
  const messages: LogMessage[] = [];
  for (let position = 0; position < rows.length; position++) {
    const row = rows[position];
    if (!isRecord(row) || !Number.isSafeInteger(row.step_index) || (row.step_index as number) < 0) continue;
    const id = `agy-${row.step_index}`;
    const at = Date.parse(text(row.created_at)) || 0;
    if (row.type === "USER_INPUT" && row.source === "USER_EXPLICIT") {
      const content = antigravityUserText(text(row.content));
      if (content) messages.push({ id, at, role: "you", blocks: [{ kind: "text", text: excerpt(content, TEXT_LIMIT) }] });
      continue;
    }
    if (row.type !== "PLANNER_RESPONSE" || row.source !== "MODEL") continue;
    const blocks: LogBlock[] = [];
    let shortened = text(row.thinking).length > TEXT_LIMIT || text(row.content).length > TEXT_LIMIT;
    if (text(row.thinking).trim()) blocks.push({ kind: "thinking", text: excerpt(text(row.thinking), TEXT_LIMIT) });
    if (text(row.content).trim()) blocks.push({ kind: "text", text: excerpt(text(row.content), TEXT_LIMIT) });
    let bytes = Buffer.byteLength(JSON.stringify(blocks));
    const calls = Array.isArray(row.tool_calls) ? row.tool_calls : [];
    const next = rows[position + 1];
    const result = calls.length === 1 && !truncated(row, "tool_calls") && isRecord(next) && next.type === "GENERIC" && next.source === "MODEL" &&
      next.step_index === (row.step_index as number) + 1 ? next : undefined;
    shortened ||= calls.length > CALL_LIMIT;
    for (const call of calls.slice(0, CALL_LIMIT)) {
      if (!isRecord(call) || typeof call.name !== "string" || !call.name) continue;
      const args = argumentsOf(call.args);
      const { shortened: questionShortened, ...questions } = questionsOf(call.name, args);
      shortened ||= questionShortened || call.name.length > 200 || [args.TargetFile, args.AbsolutePath].some(value => typeof value === "string" && (value.length > 4096 || basename(value).length > 256));
      const output = result && (text(result.content) || text(result.error));
      const hasOutput = !!output || !!result && (result.status === "DONE" || result.status === "ERROR");
      const block: LogBlock = {
        kind: "tool", name: excerpt(call.name, 200), summary: summaryOf(args), ...fileOf(args), ...questions,
        result: hasOutput ? {
          text: (output ?? "").length > RESULT_LIMIT ? cut(output ?? "", RESULT_LIMIT) + "\n…" : output ?? "",
          isError: result?.status === "ERROR" || !!text(result?.error),
          truncated: (output ?? "").length > RESULT_LIMIT || !!result && truncated(result, "content"), images: [],
        } : null,
        ...(calls.length !== 1 || truncated(row, "tool_calls") ? { outputUnavailable: true } : {}),
      };
      const size = Buffer.byteLength(JSON.stringify(block));
      if (bytes + size > BLOCK_BYTES) { shortened = true; break; }
      blocks.push(block); bytes += size;
    }
    if (shortened) blocks.push({ kind: "text", text: "Additional message content exceeds the Reader limit; view it in Antigravity." });
    if (truncated(row, "content") || truncated(row, "thinking") || truncated(row, "tool_calls")) {
      blocks.push({ kind: "text", text: "Antigravity truncated this part of the saved transcript." });
    }
    if (blocks.length) messages.push({ id, at, role: "agent", blocks });
  }
  return messages;
}

export async function readAntigravityLog(path: string, options: { limit?: number; before?: number } = {}): Promise<SessionLog | null> {
  const id = basename(dirname(dirname(dirname(path))));
  if (!UUID.test(id)) return null;
  // /rewind can replace this conversation in place while retaining step IDs.
  // Revision-scoped paths make both clients drop loaded history removed by it.
  const log = await readWindow(path, { ...options, revision: true }, normaliseAntigravity);
  return log && inTranscript(log, id);
}
