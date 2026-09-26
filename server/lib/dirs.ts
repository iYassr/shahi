/**
 * Directory listing, for choosing where a new space lives.
 *
 * Typing `/home/operator/projects/whatever` on a phone keyboard is miserable,
 * so the app offers a browsable list instead. herdr has no filesystem API — it
 * has no reason to — but this process already runs on the box, so it can answer.
 *
 * Scoped to the home directory and resolved through `realpath`, so a symlink or
 * a `..` cannot walk out of it. That is a real constraint rather than a
 * formality: this endpoint sits behind the same passcode as everything else,
 * and everything else can already run arbitrary commands — but a path traversal
 * that leaks directory structure is still worth not having.
 */
import type { DirEntry, DirListing } from "@shahi/shared";
import { access, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { realPath, realPathSync } from "./real-path";

export type { DirEntry, DirListing };
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";



const HOME = homedir();

/**
 * Home as `realpath` reports it, which is what a resolved path is compared
 * with. `$HOME` can be a symlink (`/home` -> `/var/home`, `/usr/home`), and
 * against the unresolved name every folder, `~` included, was "outside the
 * home directory": the folder picker refused everything (review finding F90).
 * `files.ts` resolves its roots for the same reason.
 */
const REAL_HOME = (() => {
  try {
    return realPathSync(HOME);
  } catch {
    return HOME;
  }
})();

/** `~/projects` -> `/home/you/projects`, and plain `~` -> home. */
export function expandHome(input: string): string {
  if (input === "~") return HOME;
  if (input.startsWith("~/")) return join(HOME, input.slice(2));
  return input;
}

/**
 * `/home/you/projects` -> `~/projects`. Either spelling of home collapses:
 * herdr reports a pane's directory as the shell has it, and a listing reports
 * resolved paths.
 */
export function collapseHome(path: string): string {
  for (const home of [HOME, REAL_HOME]) {
    if (path === home) return "~";
    if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  }
  return path;
}

export class OutsideHomeError extends Error {
  constructor(path: string) {
    super(`${path} is outside the home directory`);
    this.name = "OutsideHomeError";
  }
}

/**
 * Resolves a requested path, refusing anything that escapes home.
 *
 * Resolution happens before the check, so `~/../etc` and a symlink pointing at
 * `/etc` are both rejected rather than followed.
 */
export async function resolveWithinHome(input: string): Promise<string> {
  const expanded = expandHome(input || "~");
  const absolute = isAbsolute(expanded) ? expanded : resolve(HOME, expanded);

  // realpath throws on a missing path, which is the right answer for a picker.
  const real = await realPath(absolute);
  if (real !== REAL_HOME && !real.startsWith(`${REAL_HOME}/`)) throw new OutsideHomeError(input);
  return real;
}

/**
 * Lists the contents of `path`, hiding dotfiles.
 *
 * Directories only by default — choosing where a space lives. With
 * `includeFiles`, files come too, for attaching something already on the
 * server. Directories sort first either way, so browsing stays predictable.
 */
export async function listDirectories(
  input: string,
  options: { includeFiles?: boolean } = {},
): Promise<DirListing> {
  const path = await resolveWithinHome(input);

  const entries = await readdir(path, { withFileTypes: true });
  const directories = (
    await Promise.all(
      entries
        .filter((entry) => !entry.name.startsWith("."))
        .filter((entry) => entry.isDirectory() || (options.includeFiles && entry.isFile()))
        .map(async (entry) => {
          const full = join(path, entry.name);
          const isDirectory = entry.isDirectory();
          let size: number | undefined;
          if (!isDirectory) {
            try {
              size = (await stat(full)).size;
            } catch {
              size = undefined;
            }
          }
          return { name: entry.name, path: full, display: collapseHome(full), isDirectory, size };
        }),
    )
  ).sort(
    (a, b) =>
      Number(b.isDirectory) - Number(a.isDirectory) ||
      a.name.localeCompare(b.name, undefined, { numeric: true }),
  );

  return {
    path,
    display: collapseHome(path),
    // No climbing above home, so the picker cannot strand you somewhere
    // you are not allowed to list.
    parent: path === REAL_HOME ? null : collapseHome(resolve(path, "..")),
    entries: directories,
  };
}

/**
 * Why `cwd` cannot be where a new space, tab or agent starts, or null when it
 * can. No folder at all means herdr's default, which is fine.
 *
 * herdr cannot start anything in a folder it cannot enter, and does not say
 * so: for `~`, a relative path, a folder that does not exist or a file, it
 * silently uses $HOME, and the space or agent looks as if it went where it was
 * asked. A project deleted or renamed after its space was made put an agent in
 * bypass-permissions mode in the home directory, under a card still naming
 * the project (pre-release bug hunt, B9). Not scoped to home, unlike the
 * listing above: a space can live anywhere its owner can go.
 */
export async function folderProblem(cwd: unknown): Promise<string | null> {
  if (cwd === null || cwd === undefined || cwd === "") return null;
  // The old wording, kept: clients have shown it since `~` was first refused.
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return "cwd must be an absolute path";
  try {
    if (!(await stat(cwd)).isDirectory()) return "That path is a file, not a folder.";
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "That folder does not exist on this computer.";
    return "That folder cannot be opened on this computer.";
  }
  // A folder that cannot be entered is $HOME to herdr just the same.
  try {
    await access(cwd, constants.X_OK);
    return null;
  } catch {
    return "That folder cannot be opened on this computer.";
  }
}
