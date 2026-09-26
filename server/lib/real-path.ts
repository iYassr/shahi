/**
 * A path as the filesystem knows it: absolute, with every symlink followed.
 *
 * `fs.realpath` would be the answer, but Bun's reads a backslash in the path it
 * is given as a separator, on macOS and in every form (promise, sync, native,
 * Buffer, URL). A backslash is an ordinary character in a macOS or Linux file
 * name, so `~/proj\one` could not be listed, `~/we"ird\name.txt` could not be
 * opened, and `~/a\b.txt` served the contents of `~/a/b.txt` under the name
 * `b.txt` (pre-release bug hunt, September 2026; Bun 1.3.13 and 1.4.0, where
 * Node answers correctly). Only the path handed to it is misread: a symlink
 * whose target has a backslash resolves correctly, and `lstat`, `readlink`,
 * `stat`, `readdir` and `Bun.file` all take such a name as it is.
 *
 * So a path with a backslash in it is resolved here one component at a time
 * with `lstat` and `readlink`, which is what `realpath` does, and any other
 * path still goes to `realpath`. The walk folds `.` and `..` in the path as
 * written first, as `realpath` does in Bun and in Node, and follows a link's
 * target from the link's real directory, as the operating system does.
 */
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

/** Linux's MAXSYMLINKS (macOS allows 32): past this many links, a path is a loop. */
const MAX_LINKS = 40;

/** `fs.promises.realpath`, correct for a name with a backslash in it. */
export async function realPath(path: string): Promise<string> {
  return path.includes("\\") ? resolveByComponent(path) : realpath(path);
}

/** `fs.realpathSync`, correct for a name with a backslash in it. */
export function realPathSync(path: string): string {
  return path.includes("\\") ? resolveByComponent(path) : realpathSync(path);
}

/**
 * Follows `path` one component at a time.
 *
 * Synchronous even for `realPath`: it is taken only for the rare name with a
 * backslash, and costs one `lstat` per component, so one code path serves
 * both callers rather than two copies that could drift apart.
 */
function resolveByComponent(path: string): string {
  const absolute = resolve(path);
  // The components still to walk, the next one last.
  const rest = absolute.split("/").reverse();
  // The components walked so far, none of them a link, so `..` is their parent.
  const real: string[] = [];
  let links = 0;
  while (rest.length > 0) {
    const part = rest.pop()!;
    if (part === "" || part === ".") continue;
    if (part === "..") { real.pop(); continue; }
    const candidate = `/${[...real, part].join("/")}`;
    // Throws ENOENT for a missing component and ENOTDIR for one under a file.
    if (lstatSync(candidate).isSymbolicLink()) {
      if (++links > MAX_LINKS) throw loop(absolute);
      const target = readlinkSync(candidate);
      if (target.startsWith("/")) real.length = 0;
      rest.push(...target.split("/").reverse());
      continue;
    }
    real.push(part);
  }
  return `/${real.join("/")}`;
}

/** The error `realpath` gives for a chain of links that never ends. */
function loop(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ELOOP: too many symbolic links encountered, realpath '${path}'`), { code: "ELOOP", path, syscall: "realpath" });
}
