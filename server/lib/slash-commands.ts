/**
 * The custom slash commands a pane's agent offers, for the composer's picker
 * (`GET /api/panes/:id/commands`, capability `commands`).
 *
 * Names and one-line descriptions only. A command's file is a prompt the
 * person wrote, and its body never leaves the computer: each file is read
 * only as far as its frontmatter and first line, and only what the agent's
 * own `/` menu would show is kept.
 *
 * Claude Code (code.claude.com/docs/en/skills, October 2026):
 *  - `<dir>/commands/**\/*.md` is `/name`, a subfolder joined on with `:`
 *    (`frontend/component.md` is `/frontend:component`);
 *  - `<dir>/skills/<name>/SKILL.md` is `/name`, or its frontmatter `name`,
 *    hidden from the menu with `user-invocable: false`;
 *  - the description is the frontmatter's, else the first non-empty line;
 *  - `<dir>` is the configuration directory for the person's own, and
 *    `.claude` in the folder Claude started in and each parent up to the
 *    repository root for the project's; personal wins over project, and a
 *    skill over a command of the same name.
 * Measured against Claude Code 2.1.288's own `/` menu in a scratch project,
 * nested folders and a file with no frontmatter included.
 *
 * Codex has none to read. Its documented `$CODEX_HOME/prompts/*.md`, typed
 * `/prompts:name`, is gone from 0.160.0: the binary holds no `prompts:` and
 * the menu offers none; its docs call prompts deprecated in favour of skills,
 * which that menu does not list either. Other agents' panes get built-ins.
 *
 * Every file found must stay inside the folder it was found in once links
 * are followed, and is opened without blocking and checked to be a file on
 * that same handle — a named pipe called `x.md` must not hang the request
 * (see `readWithinHome`). The walk, the count and the bytes read are all
 * bounded, so a home folder with a thousand prompts costs the same as one
 * with fifty.
 */

import { constants } from "node:fs";
import { open, opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { builtinCommands, mergeCommands, type CommandSource, type SlashCommand } from "@shahi/shared";
import { realPath } from "./real-path";
import { claudeConfigDir } from "./session-log";

/** Custom commands kept per pane, after which the rest are not read. */
export const MAX_COMMANDS = 200;
/** Directory entries read from any one folder. */
const MAX_ENTRIES = 1_000;
/** Entries looked at per request, files and folders alike, across every folder walked. */
const MAX_VISITS = 4_000;
/** How deep `commands/` may nest namespaces. */
const MAX_DEPTH = 3;
/** Read from each file: enough for frontmatter and a first line, never the prompt. */
const HEAD_BYTES = 4_096;
/** Parents of the starting folder searched for a repository root. */
const MAX_PARENTS = 10;
const MAX_NAME = 80;
const MAX_DESCRIPTION = 160;

/** One `:`-separated part of a name: letters and digits of any script, `_`, `.`, `-`. */
const SEGMENT = /^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u;

export interface CommandRoots {
  /** Claude Code's configuration directory (`CLAUDE_CONFIG_DIR`, else `~/.claude`). */
  claudeDir: string;
  /** Where the walk for a repository root stops: never above the person's home. */
  home: string;
}

export const defaultRoots = (): CommandRoots => ({ claudeDir: claudeConfigDir(), home: homedir() });

/** The commands to offer for an agent of `agent` running in `cwd`: custom ones first by precedence, then built-ins. */
export async function paneCommands(agent: string | null | undefined, cwd: string | null | undefined, roots: CommandRoots = defaultRoots()): Promise<SlashCommand[]> {
  const budget: Budget = { left: MAX_COMMANDS, visits: MAX_VISITS };
  const lists: SlashCommand[][] = [];
  if (agent === "claude") {
    lists.push(await skills(join(roots.claudeDir, "skills"), "user", budget));
    lists.push(await commands(join(roots.claudeDir, "commands"), "user", budget));
    for (const dir of cwd ? await projectDirs(cwd, roots.home) : []) {
      lists.push(await skills(join(dir, ".claude", "skills"), "project", budget));
      lists.push(await commands(join(dir, ".claude", "commands"), "project", budget));
    }
  }
  return mergeCommands(...lists, builtinCommands(agent));
}

/**
 * The folder Claude started in and each parent up to the repository root,
 * nearest first. Outside a repository, the folder alone: walking on up would
 * offer a stranger's commands from whatever folder happens to hold this one.
 * The home folder is never a project — its `.claude` is the person's own.
 */
async function projectDirs(cwd: string, home: string): Promise<string[]> {
  if (!cwd.startsWith("/")) return [];
  const dirs: string[] = [];
  let dir = cwd;
  for (let i = 0; i <= MAX_PARENTS; i++) {
    if (dir === home) break;
    dirs.push(dir);
    if (await exists(join(dir, ".git"))) return dirs;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs.slice(0, 1);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/** Commands still to be kept, and directory entries still to be looked at. */
interface Budget {
  left: number;
  visits: number;
}

/** `<root>/**\/*.md` as `a:b:name`, `MAX_DEPTH` folders down at most. */
async function commands(root: string, source: CommandSource, budget: Budget): Promise<SlashCommand[]> {
  const real = await realRoot(root);
  if (!real) return [];
  const found: SlashCommand[] = [];
  // A folder linked back into the tree is walked once, not once per name.
  const walked = new Set([real]);
  const walk = async (dir: string, prefix: string[], level: number): Promise<void> => {
    for (const entry of await entries(dir, budget)) {
      if (budget.left <= 0) return;
      const path = await within(real, join(dir, entry));
      if (!path) continue;
      const info = await stat(path).catch(() => null);
      if (info?.isDirectory()) {
        if (level < MAX_DEPTH && SEGMENT.test(entry) && !walked.has(path)) {
          walked.add(path);
          await walk(path, [...prefix, entry], level + 1);
        }
        continue;
      }
      if (!entry.endsWith(".md")) continue;
      const name = [...prefix, entry.slice(0, -3)].join(":");
      if (!validName(name)) continue;
      const head = await readHead(path);
      if (head === null) continue;
      const { fields, firstLine } = frontmatter(head);
      found.push({ name, description: clean(fields.get("description") || firstLine), source });
      budget.left--;
    }
  };
  await walk(real, [], 0);
  return found;
}

/** `<root>/<name>/SKILL.md`, named by its frontmatter `name` or its folder. */
async function skills(root: string, source: CommandSource, budget: Budget): Promise<SlashCommand[]> {
  const real = await realRoot(root);
  if (!real) return [];
  const found: SlashCommand[] = [];
  for (const entry of await entries(real, budget)) {
    if (budget.left <= 0) break;
    const folder = await within(real, join(real, entry));
    if (!folder) continue;
    const path = await within(real, join(folder, "SKILL.md"));
    const head = path ? await readHead(path) : null;
    if (head === null) continue;
    const { fields, firstLine } = frontmatter(head);
    if (/^false$/i.test(fields.get("user-invocable") ?? "")) continue;
    const name = fields.get("name") || entry;
    if (!validName(name)) continue;
    found.push({ name, description: clean(fields.get("description") || firstLine), source });
    budget.left--;
  }
  return found;
}

async function realRoot(root: string): Promise<string | null> {
  const real = await realPath(root).catch(() => null);
  return real && (await stat(real).catch(() => null))?.isDirectory() ? real : null;
}

/**
 * Visible names in a folder, sorted, charged to the request's budget. Read
 * through a handle so a folder of a million files is never listed whole: a
 * link loop or a generated tree costs its budget and no more.
 */
async function entries(dir: string, budget: Budget): Promise<string[]> {
  const names: string[] = [];
  const handle = await opendir(dir).catch(() => null);
  if (!handle) return names;
  try {
    for await (const entry of handle) {
      if (names.length >= MAX_ENTRIES || budget.visits <= 0) break;
      budget.visits--;
      if (!entry.name.startsWith(".")) names.push(entry.name);
    }
  } catch {
    // A folder that vanished mid-read offers what was read.
  }
  return names.sort();
}

/** `path` with its links followed, if that is still inside `root`. */
async function within(root: string, path: string): Promise<string | null> {
  const real = await realPath(path).catch(() => null);
  return real && (real === root || real.startsWith(root.endsWith(sep) ? root : root + sep)) ? real : null;
}

/**
 * The start of a regular file, as text; null for anything else. Opened
 * without blocking and checked on the handle, so a pipe is refused rather
 * than waited on, and cannot be swapped in after a check of the path.
 */
async function readHead(path: string): Promise<string | null> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => null);
  if (!handle) return null;
  try {
    if (!(await handle.stat()).isFile()) return null;
    const bytes = new Uint8Array(HEAD_BYTES);
    const { bytesRead } = await handle.read(bytes, 0, HEAD_BYTES, 0);
    // A multi-byte character cut at the end decodes to U+FFFD, which only a
    // description reaching that far could show, and `clean` cuts long before.
    return new TextDecoder().decode(bytes.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

function validName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_NAME && name.split(":").every((part) => SEGMENT.test(part));
}

/**
 * The top-level keys of a YAML frontmatter block, enough of YAML for what a
 * command file holds: plain, quoted and block (`>`, `|`) scalars, a plain one
 * continued on indented lines, and comments. Anything else is skipped, and
 * the first non-empty line after the block stands in for a description.
 */
export function frontmatter(text: string): { fields: Map<string, string>; firstLine: string } {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const fields = new Map<string, string>();
  let body = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line));
    // Never closed, or closed past the bytes read: neither its fence nor its
    // keys are a description.
    if (end < 0) return { fields, firstLine: "" };
    body = end + 1;
    for (let i = 1; i < end; i++) {
      const key = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(lines[i]!);
      if (!key) continue;
      const continued: string[] = [];
      while (i + 1 < end && /^\s+\S/.test(lines[i + 1]!)) continued.push(lines[++i]!.trim());
      fields.set(key[1]!.toLowerCase(), scalar((key[2] ?? "").trim(), continued));
    }
  }
  const firstLine = lines.slice(body).find((line) => line.trim() !== "")?.trim() ?? "";
  return { fields, firstLine };
}

function scalar(value: string, continued: string[]): string {
  if (/^[|>][-+0-9]*(\s+#.*)?$/.test(value)) return continued.join(" ");
  if (value.startsWith('"')) {
    const closed = /^"((?:[^"\\]|\\.)*)"/.exec(value);
    try {
      return closed ? (JSON.parse(`"${closed[1]}"`) as string) : value.slice(1);
    } catch {
      return closed![1]!;
    }
  }
  if (value.startsWith("'")) {
    const closed = /^'((?:[^']|'')*)'/.exec(value);
    return closed ? closed[1]!.replace(/''/g, "'") : value.slice(1);
  }
  // In a plain scalar a ` #` starts a comment, as Claude Code's YAML reads it.
  return [value, ...continued].join(" ").replace(/(^|\s)#.*$/, "").trim();
}

/**
 * One line of plain text: no terminal escapes, control or bidirectional
 * formatting characters — a description is drawn on a phone, and a file
 * could carry any of them — and at most `MAX_DESCRIPTION` characters, cut
 * between graphemes, never inside an emoji.
 */
export function clean(text: string): string {
  const plain = text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)?|\x1b./g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= MAX_DESCRIPTION) return plain;
  let out = "";
  for (const { segment } of new Intl.Segmenter().segment(plain)) {
    if (out.length + segment.length > MAX_DESCRIPTION - 1) break;
    out += segment;
  }
  return `${out.trimEnd()}…`;
}
