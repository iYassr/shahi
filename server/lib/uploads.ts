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
import { chmod, mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";

export type { StoredUpload };
import { homedir } from "node:os";
import { extname, join } from "node:path";

export const UPLOAD_DIR =
  process.env.SHAHI_UPLOADS ?? join(homedir(), ".local", "share", "shahi", "uploads");

/** A phone photo is a few MB; well past that is a mistake, not an attachment. */
export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

/** Uploads older than this are swept on the next write. */
const KEEP_MS = 14 * 24 * 60 * 60 * 1000;


/**
 * Past MAX_UPLOAD_BYTES. Worded as the chunked route and both clients word it:
 * this used to divide the binary limit by a decimal million and print "file is
 * 34.6MB, over the 33.554432MB limit", which the native Attach sheet shows as
 * it stands over SSH (September 2026 pre-release bug hunt).
 */
export class UploadTooLarge extends Error {
  constructor(readonly size: number) {
    super("Files can be up to 32 MB");
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
export function safeName(raw: string | undefined): string {
  // Bun 1.3 may omit the name on a zero-byte multipart File.
  const base = (raw ?? "").split(/[/\\]/).pop() ?? "";
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 96);
  return cleaned || "upload";
}

/**
 * Creates the upload directory, readable by this user only.
 *
 * The multipart route made it with the process umask and wrote 0644 files, so
 * on a shared machine with a 0755 home another account could list and read
 * whatever was sent from the phone (review finding F91). `chmod` as well as
 * `mkdir`'s mode, because a directory an older version made already exists
 * and `mkdir` leaves it alone.
 */
export async function privateDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
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

  await privateDirectory(dir);
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

  // `Bun.write` ignores its `mode` for a Blob source (measured on Bun 1.4:
  // the file came out 0644), so the file is created 0600 here instead.
  await writeFile(path, new Uint8Array(await file.arrayBuffer()), { mode: 0o600 });

  return {
    name: clean,
    path,
    size: file.size,
    type: file.type || "application/octet-stream",
  };
}

/** Deletes uploads past their keep window, so the directory does not grow forever. */
export async function sweepOldUploads(now = Date.now, dir = UPLOAD_DIR): Promise<number> {
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
