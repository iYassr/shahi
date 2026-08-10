/**
 * Files sent from the phone.
 *
 * The destination is deliberately not the agent's working directory. An upload
 * arriving from a phone should never be able to land on a source file, and
 * writing into a repo the agent is mid-edit on invites exactly that. Everything
 * goes to one owned directory and the agent is handed an absolute path.
 *
 * That path is the whole mechanism, and it is why "from the phone" and "from
 * the server" end up in the same place: a photo picked on the phone becomes a
 * file on this machine, and both cases are then just a path in the message. The
 * agent reads it with the same tool it uses for any other file — including
 * images, which Claude Code's Read tool handles.
 */
import type { StoredUpload } from "@shahi/shared";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";

export type { StoredUpload };
import { homedir } from "node:os";
import { extname, join } from "node:path";

export const UPLOAD_DIR =
  process.env.SHAHI_UPLOADS ?? join(homedir(), ".local", "share", "shahi", "uploads");

/** A phone photo is a few MB; well past that is a mistake, not an attachment. */
export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

/** Uploads older than this are swept on the next write. */
const KEEP_MS = 14 * 24 * 60 * 60 * 1000;


export class UploadTooLarge extends Error {
  constructor(size: number) {
    super(`file is ${(size / 1e6).toFixed(1)}MB, over the ${MAX_UPLOAD_BYTES / 1e6}MB limit`);
    this.name = "UploadTooLarge";
  }
}

/**
 * Reduces a client-supplied filename to something safe to join onto a path.
 *
 * The name arrives from a browser and must be treated as hostile: `../` walks
 * out of the upload directory, and a leading dot hides the result. Everything
 * outside a conservative set is replaced rather than stripped, so two different
 * names cannot collapse into one.
 */
export function safeName(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? "";
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 96);
  return cleaned || "upload";
}

/**
 * Writes a file and returns where it landed.
 *
 * `dir` exists so tests never touch the real upload directory. They previously
 * did — writing to it and then removing it recursively on teardown — which
 * silently destroyed files a user had actually uploaded. A default that points
 * at live data is a trap; passing the directory in makes the test's target
 * explicit at the call site.
 */
export async function storeUpload(
  file: File,
  now = Date.now,
  dir = UPLOAD_DIR,
): Promise<StoredUpload> {
  if (file.size > MAX_UPLOAD_BYTES) throw new UploadTooLarge(file.size);

  await mkdir(dir, { recursive: true });
  void sweepOldUploads(now, dir).catch(() => {});

  const clean = safeName(file.name);
  const extension = extname(clean);
  const stem = extension ? clean.slice(0, -extension.length) : clean;

  // Timestamped to the millisecond AND salted with random bytes: a
  // second-resolution stamp let two photos of the same name in the same second
  // resolve to one path and silently overwrite each other (reproduced in the
  // review). The full ISO timestamp keeps the newest obvious when browsing; the
  // random suffix makes a collision astronomically unlikely regardless.
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
  const salt = randomBytes(4).toString("hex");
  const path = join(dir, `${stamp}_${salt}_${stem}${extension}`);

  await Bun.write(path, file);

  return {
    name: clean,
    path,
    size: file.size,
    type: file.type || "application/octet-stream",
  };
}

/** Deletes uploads past their keep window, so the directory does not grow forever. */
async function sweepOldUploads(now = Date.now, dir = UPLOAD_DIR): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }

  const cutoff = now() - KEEP_MS;
  for (const entry of entries) {
    const path = join(dir, entry);
    try {
      if ((await stat(path)).mtimeMs < cutoff) {
        await unlink(path);
        removed++;
      }
    } catch {
      // Vanished or unreadable; nothing to do.
    }
  }
  return removed;
}
