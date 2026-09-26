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
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { OutsideHomeError, expandHome } from "./dirs";
import { realPath, realPathSync } from "./real-path";

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

/**
 * One byte range as a `Range` header asks for it (RFC 9110 §14.1.2): from a
 * first byte, to a last one or to the end, or the final `suffix` bytes. Only
 * the file's size turns it into positions, so it is resolved once the file is
 * open.
 */
export type ByteRange = { start: number; end?: number } | { suffix: number };

export interface FileRequest {
  path: string;
  /** Force a download rather than letting the browser display it. */
  download?: boolean;
  range?: ByteRange;
}

/**
 * The single range a `Range` header asks for, or undefined for any header this
 * route does not serve: another unit, several ranges, or a malformed one.
 * RFC 9110 lets a server ignore a Range it does not handle and send the whole
 * file, and that is what this route does. It used to accept only
 * `bytes=<first>-<last>` and answer 416 to everything else, so a standard
 * resume (`bytes=<n>-`, as `curl -C -` sends), a suffix range or an upper-case
 * unit failed while the route advertised `Accept-Ranges: bytes` (September
 * 2026 pre-release bug hunt). Shahi's own clients send only closed ranges.
 */
export function parseRange(header: string | null | undefined): ByteRange | undefined {
  const match = header?.trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) return undefined;
  const [, first = "", last = ""] = match;
  if (first === "") return last === "" ? undefined : { suffix: Number(last) };
  const start = Number(first);
  if (last === "") return { start };
  const end = Number(last);
  // A last byte before the first is an invalid range, not an unsatisfiable
  // one, and is ignored like any other malformed header.
  return end < start ? undefined : { start, end };
}

/** A range that names no byte of the file. Carries the size, which the 416's Content-Range must state. */
export class RangeNotSatisfiable extends Error {
  constructor(readonly size: number) {
    super("That part of the file does not exist.");
    this.name = "RangeNotSatisfiable";
  }
}

function resolveRange(range: ByteRange, size: number): { start: number; end: number } {
  if ("suffix" in range) {
    if (range.suffix === 0) throw new RangeNotSatisfiable(size);
    return { start: Math.max(0, size - range.suffix), end: size - 1 };
  }
  if (range.start >= size) throw new RangeNotSatisfiable(size);
  return { start: range.start, end: Math.min(range.end ?? size - 1, size - 1) };
}

/**
 * Past the ceiling. The route answers it as 413 `file_too_large`: the relay
 * also answers 413, for a whole file that will not fit in one frame, and a
 * client has to tell a final "too large" from "this computer needs an update".
 * Clients also recognise the wording this used to have, "file is <n> bytes,
 * over the <n> limit", for computers that send no code.
 */
export class FileTooLarge extends Error {
  constructor(readonly bytes: number) {
    super("This file is over 25 MB, which is too large to open or download through Shahi. Open it on your computer.");
    this.name = "FileTooLarge";
  }
}

/**
 * A path that names something other than a file: a folder, or a named pipe,
 * socket or device. Its own error so the route can say which. A folder inside
 * the home directory used to be refused as "outside the home directory", which
 * the web viewer showed word for word (September 2026 pre-release bug hunt).
 */
export class NotAFileError extends Error {
  constructor(readonly folder: boolean) {
    super(folder ? "That is a folder, not a file." : "That is not a regular file, so Shahi will not open it.");
    this.name = "NotAFileError";
  }
}

/**
 * A `Content-Disposition` for any name a file can have.
 *
 * Header values are bytes, and `Headers` throws on anything above U+00FF: an
 * Arabic or emoji name, or the U+202F macOS puts before "AM" in a screenshot's
 * name, made `/api/file` answer "cannot read that file" for a file that was
 * there (review finding F38). RFC 6266 has the answer: an ASCII `filename`
 * for clients that know no better and the real name, percent-encoded, in
 * `filename*`. Quotes and backslashes would end the quoted string and control
 * characters (a newline is a legal filename on Linux) would end the header, so
 * the fallback replaces them too.
 *
 * Here rather than in the route so the e2e stub sends the same header: its own
 * copy put the raw name in `filename="…"`, so every accented, Arabic or emoji
 * name was a 500 from the stub alone (September 2026 pre-release bug hunt).
 */
export function contentDisposition(kind: "inline" | "attachment", name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  // encodeURIComponent leaves ' ( ) * alone, which RFC 8187 does not allow bare.
  const encoded = encodeURIComponent(name.toWellFormed()).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function contentTypeFor(path: string, { download = false } = {}): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (download) return "application/octet-stream";
  if (NEVER_INLINE.has(ext)) return "text/plain; charset=utf-8";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
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
    return realPathSync(root);
  } catch {
    return root;
  }
});

const within = (real: string, root: string) => real === root || real.startsWith(`${root}/`);

/**
 * Resolves a path, following symlinks first so none of them can point out.
 *
 * Throws `OutsideHomeError` for anything outside the roots, and `realpath`'s
 * own ENOENT for anything missing.
 */
async function resolveReadable(input: string): Promise<string> {
  const expanded = expandHome(input || "~");
  const absolute = isAbsolute(expanded) ? expanded : resolve(homedir(), expanded);

  const real = await realPath(absolute);
  if (!ROOTS.some((root) => within(real, root))) throw new OutsideHomeError(input);
  return real;
}

/**
 * Resolves and reads a file, or throws.
 *
 * `OutsideHomeError` for anything outside the roots, `NotAFileError` for a
 * folder or anything else that is not a regular file, `FileTooLarge` past the
 * ceiling, and the filesystem's own error (ENOENT for a missing file) for the
 * rest.
 *
 * The file is opened without blocking, and everything after that asks the
 * open handle rather than the path. Reading a named pipe waits for a writer
 * for ever: in the September 2026 pre-release bug hunt two requests for a
 * FIFO in the home directory held both file-work slots until a restart, and
 * every later file view and upload was told the box was busy. A non-blocking
 * open returns at once even for a pipe, `fstat` on the handle says what it
 * really is, and the bytes come from that same handle, so the path cannot be
 * swapped for a pipe between the check and the read.
 */
export async function readWithinHome(
  request: FileRequest,
): Promise<{ path: string; bytes: Uint8Array; contentType: string; name: string; total: number; version: string; range?: { start: number; end: number } }> {
  const path = await resolveReadable(request.path);

  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new NotAFileError(info.isDirectory());
    if (info.size > MAX_BYTES) throw new FileTooLarge(info.size);

    // No range of an empty file can be satisfied, but the clients' first
    // request for any file is `bytes=0-524287`, and an empty file has always
    // come back whole with a 200. Ignoring the range is what the RFC allows.
    const selected = request.range && info.size > 0 ? resolveRange(request.range, info.size) : undefined;
    const start = selected?.start ?? 0;
    const bytes = new Uint8Array(selected ? selected.end - selected.start + 1 : info.size);
    let filled = 0;
    while (filled < bytes.length) {
      const { bytesRead } = await handle.read(bytes, filled, bytes.length - filled, start + filled);
      // Shorter than a moment ago: an agent is rewriting it. What was there is
      // sent; a ranged download notices the change by its version.
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return {
      path,
      bytes: filled === bytes.length ? bytes : bytes.subarray(0, filled),
      total: info.size,
      version: `${info.size}-${info.mtimeMs}`,
      range: selected,
      contentType: contentTypeFor(path, { download: request.download }),
      name: path.slice(path.lastIndexOf("/") + 1),
    };
  } finally {
    await handle.close();
  }
}
