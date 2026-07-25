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
import type { DirEntry, DirListing } from "@herdrui/shared";
import { readdir, realpath, stat } from "node:fs/promises";

export type { DirEntry, DirListing };
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";



const HOME = homedir();

/** `~/projects` -> `/home/you/projects`, and plain `~` -> home. */
export function expandHome(input: string): string {
  if (input === "~") return HOME;
  if (input.startsWith("~/")) return join(HOME, input.slice(2));
  return input;
}

/** `/home/you/projects` -> `~/projects`. */
export function collapseHome(path: string): string {
  if (path === HOME) return "~";
  return path.startsWith(`${HOME}/`) ? `~${path.slice(HOME.length)}` : path;
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
  const real = await realpath(absolute);
  if (real !== HOME && !real.startsWith(`${HOME}/`)) throw new OutsideHomeError(input);
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
    parent: path === HOME ? null : collapseHome(resolve(path, "..")),
    entries: directories,
  };
}
