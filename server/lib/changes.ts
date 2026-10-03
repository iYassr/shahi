/**
 * The Changes view: what an agent has changed in its folder, read from Git
 * (capability `changes`, shapes in `shared/src/changes.ts`). Reviewing an
 * agent's edits is most of what a person does with one from a phone, and the
 * Reader shows them only as tool activity, one call at a time.
 *
 * Read-only, and run as safely as Git allows, because opening a tab on a
 * phone must never run a program the repository chose:
 *
 * - Argument arrays, never a shell. The only path a client sends is compared
 *   with the list Git itself just gave for that repository; nothing else a
 *   client says reaches Git or the filesystem.
 * - The repository's top folder must lie inside the roots the file viewer
 *   reads (`$HOME` and the temp folder), after realpath, so a pane in `/` or a
 *   `core.worktree` pointing elsewhere reads nothing.
 * - Settings that make a read run programs are switched off on every call.
 *   Measured on Git 2.54 against a repository configured to run a marker
 *   script from each: `git status` and `git diff HEAD` ran `core.fsmonitor`,
 *   a filter's `process` (its `clean` too, when no `process` is set), a diff
 *   driver's `command` and the `post-index-change` hook. `diff.external` and
 *   a driver's `textconv` run under `git diff` as well. With the overrides
 *   below, none ran. Filter programs are named by the repository, so their
 *   names are read first (reading settings runs nothing) and each one the
 *   repository itself, or anything but the owner's own global and system
 *   files, defines is emptied. `protocol.allow=never` and `GIT_NO_LAZY_FETCH`
 *   stop a partial clone from fetching a missing object, which would run the
 *   transport and credential programs the repository names.
 * - `GIT_OPTIONAL_LOCKS=0`: `git status` otherwise refreshes the index and
 *   writes it back, which takes `index.lock` from an agent committing at that
 *   moment, and is what fires `post-index-change`.
 * - The environment is rebuilt rather than inherited, so nothing in the
 *   service's own (`GIT_DIR`, `GIT_EXTERNAL_DIFF`, `GIT_CONFIG_PARAMETERS`)
 *   reaches Git.
 * - Every call in a request shares one deadline, and its output is cut at a
 *   byte limit, with Git killed when it passes it.
 *
 * Output goes to a private file rather than a pipe, as every child of this
 * server does: under `bun test` on macOS a piped child can fail at
 * posix_spawn with EBADF (docs/on-a-mac.md).
 *
 * Neither paths nor file contents are logged; the request metrics see only
 * the route.
 */
import { constants, fstatSync } from "node:fs";
import { lstat, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ChangedFile, ChangeStatus, FileDiff, PaneChanges } from "@shahi/shared";
import { collapseHome } from "./dirs";
import { insideRoots } from "./files";
import { realPath } from "./real-path";

/** A refusal or failure for the route to answer as it stands. */
export class ChangesError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "ChangesError";
  }
}

/**
 * Everything one request asks of Git together, inside both clients' 15-second
 * request limit, so a slow repository is reported as slow rather than as a
 * connection that failed.
 */
const REQUEST_BUDGET_MS = 12_000;
/** The most of a listing's output read: about 100,000 changed files. */
const LIST_BYTES = 16 * 1024 * 1024;
/** The most of one file's diff read: far more lines than are sent. */
const DIFF_BYTES = 4 * 1024 * 1024;
/** Files listed; more than anyone reviews on a phone. */
const LIST_LIMIT = 1000;
/** Lines of one diff sent, and their weight as JSON, well under a relay body (see `fitPage`). */
const DIFF_LINES = 3000;
const DIFF_WEIGHT = 256 * 1024;
/** A line past this is cut, with its length said: minified code is one line of megabytes. */
const LINE_CHARS = 1000;
/** Untracked files are counted here, not by Git; this much of each, and of all of them, per listing. */
const COUNTED_FILE_BYTES = 2 * 1024 * 1024;
const COUNTED_BYTES = 8 * 1024 * 1024;

const EMPTY_TREE = { sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321" };

/** Before every subcommand: see the note at the top for what each one stopped. */
const SAFE = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "diff.external=", "-c", "protocol.allow=never"];
/** Plain unified output Shahi can read: no colour, no external or text-converting drivers, no recursion into submodules. */
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--ignore-submodules=dirty", "--submodule=short"];

const NOT_A_REPOSITORY = "This folder is not in a Git repository, so there are no changes to show.";
const FAILED = "Git could not read this repository.";

function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    // A listed path is a name, never a pattern: `*.ts` or `:(top)` in a file
    // name must not widen what is compared.
    GIT_LITERAL_PATHSPECS: "1",
  };
  // Which of the owner's own settings files Git reads, and where Git is.
  for (const name of ["PATH", "HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

interface GitOutput {
  code: number;
  out: string;
  /** Git wrote more than `cap` bytes and was stopped; `out` is the first `cap`. */
  cut: boolean;
}

/** Runs Git in `cwd`, bounded by the request's deadline and `cap` bytes of output. */
async function git(cwd: string, args: string[], cap: number, deadline: number): Promise<GitOutput> {
  const timeout = deadline - Date.now();
  if (timeout <= 0) throw tooSlow();
  let scratch: string | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    scratch = await mkdtemp(join(tmpdir(), "shahi-git-"));
    handle = await open(join(scratch, "out"), "w+", 0o600);
    const fd = handle.fd;
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn(["git", ...args], {
        cwd, env: gitEnv(), stdin: "ignore", stdout: fd, stderr: "ignore", timeout, killSignal: "SIGKILL",
      });
    } catch {
      throw new ChangesError("Git is not installed on this computer, or Shahi cannot run it.", 503, "git_unavailable");
    }
    let cut = false;
    const watch = setInterval(() => {
      try {
        if (fstatSync(fd).size > cap) { cut = true; child.kill("SIGKILL"); }
      } catch { /* Gone with the child; nothing left to bound. */ }
    }, 50);
    const code = await child.exited.finally(() => clearInterval(watch));
    if (child.signalCode !== null && !cut) throw tooSlow();
    const size = fstatSync(fd).size;
    const bytes = Buffer.alloc(Math.min(size, cap));
    await handle.read(bytes, 0, bytes.length, 0);
    return { code, out: bytes.toString("utf8"), cut: cut || size > cap };
  } finally {
    await handle?.close();
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

const tooSlow = () => new ChangesError("Git took too long to read this repository. Try again, or look on the computer.", 503, "git_timeout");

/** A repository as read for one request: where it is, how to run Git there, and every changed file. */
interface Listing {
  root: string;
  settings: string[];
  base: string;
  repository: NonNullable<PaneChanges["repository"]>;
  files: ChangedFile[];
  cut: boolean;
}

/** Every changed file in the repository holding `folder`, or a sentence saying why there is none to read. */
async function list(folder: string | null, deadline: number): Promise<Listing | string> {
  if (!folder) return "This pane has not said which folder it is in.";
  const there = await lstat(folder).then((info) => info.isDirectory(), () => false);
  if (!there) return "This pane's folder is not there any more.";

  const top = await git(folder, [...SAFE, "rev-parse", "--show-toplevel"], 64 * 1024, deadline);
  // 128 is Git's fatal: no repository here, or a `.git` folder rather than a work tree.
  if (top.code === 128) return NOT_A_REPOSITORY;
  if (top.code !== 0) throw new ChangesError(FAILED, 503, "git_failed");
  const root = await realPath(top.out.replace(/\n$/, "")).catch(() => null);
  if (!root || !insideRoots(root)) return "This repository is outside your home folder, so Shahi will not read it.";

  const config = await git(root, [
    ...SAFE, "config", "-z", "--show-scope", "--get-regexp", String.raw`^(filter\..+\.(clean|smudge|process)|status\.showuntrackedfiles)$`,
  ], 1024 * 1024, deadline);
  // 1: none of them is set.
  if (config.code !== 0 && config.code !== 1) throw new ChangesError(FAILED, 503, "git_failed");
  const settings = [...SAFE];
  let untracked = "all";
  const filters = new Set<string>();
  const fields = config.out.split("\0");
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const scope = fields[i]!;
    const entry = fields[i + 1]!;
    const newline = entry.indexOf("\n");
    const key = newline === -1 ? entry : entry.slice(0, newline);
    const value = newline === -1 ? "" : entry.slice(newline + 1).trim().toLowerCase();
    // "no" is honoured: a repository kept in the home folder itself says it
    // so that its status does not walk every file the person owns. Anything
    // else lists each new file, where Git's "normal" would name only a new
    // folder, and an agent's new feature is usually a folder of files.
    if (key === "status.showuntrackedfiles") untracked = ["no", "false", "off", "0"].includes(value) ? "no" : "all";
    else if (scope !== "global" && scope !== "system") filters.add(key.slice("filter.".length, key.lastIndexOf(".")));
  }
  for (const name of filters) {
    // `-c` splits at the first `=`, so such a name cannot be switched off.
    if (name.includes("=")) return "This repository's settings name a filter program Shahi cannot switch off, so Shahi does not run Git there.";
    settings.push("-c", `filter.${name}.clean=`, "-c", `filter.${name}.smudge=`, "-c", `filter.${name}.process=`, "-c", `filter.${name}.required=false`);
  }

  const status = await git(root, [
    ...settings, "status", "--porcelain=v2", "-z", "--branch", `--untracked-files=${untracked}`, "--ignore-submodules=dirty",
  ], LIST_BYTES, deadline);
  if (status.code !== 0) throw new ChangesError(FAILED, 503, "git_failed");
  const records = status.out.split("\0");
  if (status.cut) records.pop();
  let oid: string | null = null;
  let head: string | null = null;
  const untrackedPaths: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record.startsWith("# branch.oid ")) oid = record.slice("# branch.oid ".length);
    else if (record.startsWith("# branch.head ")) head = record.slice("# branch.head ".length);
    else if (record.startsWith("? ")) untrackedPaths.push(record.slice(2));
    // A rename's original path follows as a record of its own, and a name
    // can begin "? ".
    else if (record.startsWith("2 ")) i++;
  }

  // A repository with no commit yet is compared with the empty tree.
  const unborn = oid === "(initial)";
  let base = "HEAD";
  if (unborn) {
    const format = await git(root, [...settings, "rev-parse", "--show-object-format"], 1024, deadline);
    base = format.out.trim() === "sha256" ? EMPTY_TREE.sha256 : EMPTY_TREE.sha1;
  }
  // `--` after the base: a file named HEAD would otherwise make it ambiguous.
  const diff = await git(root, [...settings, "diff", "--raw", "--numstat", "-z", "--find-renames", ...DIFF_FLAGS, base, "--"], LIST_BYTES, deadline);
  if (diff.code !== 0) throw new ChangesError(FAILED, 503, "git_failed");

  const files = [
    ...trackedChanges(diff.out, diff.cut),
    ...untrackedPaths.map((path): ChangedFile => ({ path, status: "untracked", added: null, removed: null })),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    root,
    settings,
    base,
    repository: {
      name: basename(root),
      path: collapseHome(root),
      branch: head === null || head === "(detached)" ? null : head,
      commit: unborn || !oid ? null : oid.slice(0, 7),
    },
    files,
    cut: status.cut || diff.cut,
  };
}

const RAW_STATUS: Record<string, ChangeStatus> = { A: "added", D: "deleted", M: "modified", T: "modified", U: "conflicted", R: "renamed", C: "added" };

/**
 * Files from `git diff --raw --numstat -z`: every raw record first, one or
 * two paths after each header (two for a rename), then a count for each. A
 * count line never begins with `:`, and paths are taken by position, so a
 * name that begins with one is still a name.
 */
function trackedChanges(out: string, cut: boolean): ChangedFile[] {
  const fields = out.split("\0");
  if (cut) fields.pop();
  const files = new Map<string, ChangedFile>();
  let i = 0;
  while (i < fields.length && fields[i]!.startsWith(":")) {
    const letter = fields[i++]!.split(" ")[4]?.[0] ?? "M";
    const from = letter === "R" || letter === "C" ? fields[i++] : undefined;
    const path = fields[i++];
    if (path === undefined) break;
    files.set(path, { path, ...(letter === "R" && from !== undefined ? { from } : {}), status: RAW_STATUS[letter] ?? "modified", added: null, removed: null });
  }
  while (i < fields.length) {
    const count = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(fields[i++]!);
    if (!count) break;
    let path = count[3]!;
    // A rename's count names no path; its two paths follow.
    if (path === "") { i++; path = fields[i++] ?? ""; }
    const file = files.get(path);
    if (file && count[1] !== "-") {
      file.added = Number(count[1]);
      file.removed = Number(count[2]);
    }
  }
  return [...files.values()];
}

/**
 * Lines in an untracked file, which Git cannot count without staging it.
 * Null for a binary file — a NUL in its first 8,000 bytes, Git's own test —
 * and for anything it would take too long to read, a link, or not a file.
 */
async function countLines(root: string, path: string, budget: { bytes: number }): Promise<number | null> {
  if (path.endsWith("/")) return null;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // Without blocking and without following a link, so neither a pipe nor
    // a link pointing out of the repository is read.
    handle = await open(join(root, path), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > COUNTED_FILE_BYTES || info.size > budget.bytes) return null;
    budget.bytes -= info.size;
    const bytes = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const read = bytes.subarray(0, bytesRead);
    if (read.subarray(0, 8000).includes(0)) return null;
    let lines = 0;
    for (let at = read.indexOf(10); at !== -1; at = read.indexOf(10, at + 1)) lines++;
    return read.length > 0 && read[read.length - 1] !== 10 ? lines + 1 : lines;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** `GET /api/panes/:id/changes`: the changed files in the repository holding the pane's folder. */
export async function paneChanges(folder: string | null): Promise<PaneChanges> {
  const found = await list(folder, Date.now() + REQUEST_BUDGET_MS);
  if (typeof found === "string") return { repository: null, note: found, files: [], omitted: 0 };
  const files = found.files.slice(0, LIST_LIMIT);
  const budget = { bytes: COUNTED_BYTES };
  for (const file of files) {
    if (file.status !== "untracked") continue;
    file.added = await countLines(found.root, file.path, budget);
    file.removed = file.added === null ? null : 0;
  }
  return {
    repository: found.repository,
    ...(found.cut ? { note: "Git listed more changes than Shahi reads, so some are missing here." } : {}),
    files,
    omitted: found.files.length - files.length,
  };
}

/**
 * `GET /api/panes/:id/diff?path=…`: one changed file's diff against the last
 * commit. `path` must be one Git has just listed as changed, or this refuses
 * it before anything is read.
 */
export async function fileDiff(folder: string | null, path: string): Promise<FileDiff> {
  const deadline = Date.now() + REQUEST_BUDGET_MS;
  const found = await list(folder, deadline);
  if (typeof found === "string") throw new ChangesError(found, 404, "no_repository");
  const file = found.files.find((candidate) => candidate.path === path);
  if (!file) throw new ChangesError("That file has no changes any more. Refresh the list of changes.", 404, "not_changed");
  const shown = { path: file.path, ...(file.from ? { from: file.from } : {}), status: file.status };
  if (file.path.endsWith("/")) {
    return { ...shown, lines: [], omitted: 0, note: "This folder holds a Git repository of its own, so its changes are not listed here." };
  }

  const untracked = file.status === "untracked";
  const { code, out, cut } = await git(found.root, untracked
    // Not in Git yet: compared with nothing, so every line reads as added.
    ? [...found.settings, "diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "--", "/dev/null", file.path]
    : [...found.settings, "diff", ...DIFF_FLAGS, "--find-renames", found.base, "--", ...(file.from ? [file.from] : []), file.path],
  DIFF_BYTES, deadline);
  // `--no-index` answers 1 when the two differ, as they always do here.
  if (!cut && code !== 0 && !(untracked && code === 1)) throw new ChangesError(FAILED, 503, "git_failed");

  const all = out.split("\n");
  // The last line is unfinished when Git was cut off, and empty otherwise.
  all.pop();
  const first = all.findIndex((line) => line.startsWith("@@"));
  if (first === -1) {
    const note = all.some((line) => line.startsWith("Binary files ")) ? "This is a binary file, so there are no lines to show."
      : all.some((line) => line.startsWith("old mode ")) ? "Only its permissions changed; no lines did."
      : file.status === "renamed" ? "Renamed, with no lines changed."
      : "This file is empty.";
    return { ...shown, lines: [], omitted: 0, note };
  }
  // One file's diff. A second could follow only if the rename was not found
  // again in this run; its headers would read as lines.
  const next = all.findIndex((line, i) => i > first && line.startsWith("diff --git "));
  const body = all.slice(first, next === -1 ? undefined : next);

  const lines: string[] = [];
  let weight = 0;
  for (const line of body) {
    const sent = cutLine(line);
    const size = Buffer.byteLength(JSON.stringify(sent)) + 1;
    if (lines.length >= DIFF_LINES || weight + size > DIFF_WEIGHT) break;
    lines.push(sent);
    weight += size;
  }
  return { ...shown, lines, omitted: body.length - lines.length, ...(cut ? { incomplete: true } : {}) };
}

function cutLine(line: string): string {
  if (line.length <= LINE_CHARS) return line;
  // Never between the halves of a surrogate pair (see `fitPage`).
  const end = /[\uD800-\uDBFF]/.test(line[LINE_CHARS - 1]!) ? LINE_CHARS - 1 : LINE_CHARS;
  return `${line.slice(0, end)} … ${(line.length - end).toLocaleString("en-US")} more characters`;
}
