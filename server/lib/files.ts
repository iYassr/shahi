/**
 * Serving a file the agent touched.
 *
 * The reader shows tool calls, and most of them name a path — Read, Write,
 * Edit. On a phone that path is the most useful thing in the block: it is what
 * you would want to look at, and what the agent's own web client lets you open.
 * This is the endpoint behind that.
 *
 * Scoped to the home directory and the temp directory. Home is where the work
 * is; temp is where agents put everything they are not keeping — screenshots,
 * scratch output, downloads — and refusing those made the feature useless for
 * exactly the files most worth glancing at on a phone. Found by tapping a
 * screenshot and getting a broken image.
 *
 * Neither is a strong boundary: this app can already run commands as you
 * through `pane.send_text`, so anything readable here was readable anyway. It
 * exists so that a malformed or hostile path cannot quietly walk somewhere
 * nobody intended.
 */
import { realpathSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { OutsideHomeError, expandHome } from "./dirs";

/** Enough to open in a browser without pretending to be a full file server. */
const CONTENT_TYPES: Record<string, string> = {
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
  ts: "text/plain; charset=utf-8",
  tsx: "text/plain; charset=utf-8",
  js: "text/plain; charset=utf-8",
  jsx: "text/plain; charset=utf-8",
  py: "text/plain; charset=utf-8",
  rs: "text/plain; charset=utf-8",
  go: "text/plain; charset=utf-8",
  sh: "text/plain; charset=utf-8",
  toml: "text/plain; charset=utf-8",
  yaml: "text/plain; charset=utf-8",
  yml: "text/plain; charset=utf-8",
  css: "text/plain; charset=utf-8",
  html: "text/plain; charset=utf-8",
  csv: "text/plain; charset=utf-8",
  sql: "text/plain; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

/**
 * HTML and SVG are served as text rather than as themselves.
 *
 * They would otherwise run script in the app's own origin, with the session
 * cookie attached — and the whole point is to open files an agent wrote, which
 * is exactly the content least worth trusting.
 */
const NEVER_INLINE = new Set(["html", "htm", "svg", "xhtml"]);

/** Reading a whole file into memory has to stop somewhere. */
const MAX_BYTES = 25 * 1024 * 1024;

export interface FileRequest {
  path: string;
  /** Force a download rather than letting the browser display it. */
  download?: boolean;
}

export class FileTooLarge extends Error {
  constructor(readonly bytes: number) {
    super(`file is ${bytes} bytes, over the ${MAX_BYTES} limit`);
    this.name = "FileTooLarge";
  }
}

export function contentTypeFor(path: string, { download = false } = {}): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (download) return "application/octet-stream";
  if (NEVER_INLINE.has(ext)) return "text/plain; charset=utf-8";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/** True for the types the reader can show inline rather than hand to the OS. */
export function isViewable(path: string): boolean {
  const type = contentTypeFor(path);
  return type.startsWith("text/") || type.startsWith("image/") || type === "application/pdf" ||
    type.startsWith("application/json");
}

/**
 * The roots a file may be read from. See the note at the top.
 *
 * Resolved through realpath because candidates are compared after their own
 * realpath: on macOS `tmpdir()` is `/var/folders/…` while every file in it
 * resolves to `/private/var/folders/…`, and the unresolved root rejected the
 * whole temp directory.
 */
export const ROOTS = [homedir(), tmpdir()].map((root) => {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
});

const within = (real: string, root: string) => real === root || real.startsWith(`${root}/`);

/**
 * Resolves a path, following symlinks first so none of them can point out.
 *
 * Throws `OutsideHomeError` for anything outside the roots, and for anything
 * missing — `realpath` refuses both.
 */
async function resolveReadable(input: string): Promise<string> {
  const expanded = expandHome(input || "~");
  const absolute = isAbsolute(expanded) ? expanded : resolve(homedir(), expanded);

  const real = await realpath(absolute);
  if (!ROOTS.some((root) => within(real, root))) throw new OutsideHomeError(input);
  return real;
}

/**
 * Resolves and reads a file, or throws.
 *
 * `OutsideHomeError` for anything outside the roots or missing, and
 * `FileTooLarge` past the ceiling.
 */
export async function readWithinHome(
  request: FileRequest,
): Promise<{ path: string; bytes: Uint8Array; contentType: string; name: string }> {
  const path = await resolveReadable(request.path);

  const info = await stat(path);
  if (info.isDirectory()) throw new OutsideHomeError(request.path);
  if (info.size > MAX_BYTES) throw new FileTooLarge(info.size);

  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  return {
    path,
    bytes,
    contentType: contentTypeFor(path, { download: request.download }),
    name: path.slice(path.lastIndexOf("/") + 1),
  };
}
