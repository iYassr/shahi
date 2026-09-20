/** Resumable uploads stay on the computer; the relay only forwards bounded chunks. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, readdir, unlink, open, stat } from "node:fs/promises";
import { join } from "node:path";
import { MAX_UPLOAD_BYTES, UPLOAD_DIR, safeName, sweepOldUploads } from "./uploads";
import type { StoredUpload } from "@shahi/shared";

export const TRANSFER_CHUNK = 64 * 1024;
const LIFETIME = 60 * 60_000;
interface Transfer {
  owner: string; name: string; type: string; size: number; offset: number;
  expires: number; digest?: string; result?: StoredUpload;
}
export class TransferError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Serialize disk mutations so a lost-response retry cannot append twice. The
 * journal is durable before acknowledging; a restart truncates uncommitted bytes. */
export class UploadTransfers {
  private queue = Promise.resolve();
  private root: string;
  constructor(private dir = UPLOAD_DIR, private now = Date.now) { this.root = join(dir, ".transfers"); }
  async run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.then(() => {}, () => {});
    return result;
  }
  private path(id: string, suffix = ".json") {
    if (!/^[a-zA-Z0-9_-]{16,64}$/.test(id)) throw new TransferError(400, "Invalid upload ID");
    return join(this.root, id + suffix);
  }
  private async save(id: string, t: Transfer) {
    const temp = this.path(id, ".new");
    await writeFile(temp, JSON.stringify(t), { mode: 0o600 });
    const file = await open(temp, "r"); try { await file.sync(); } finally { await file.close(); }
    await rename(temp, this.path(id));
    const directory = await open(this.root, "r"); try { await directory.sync(); } finally { await directory.close(); }
  }
  private async load(id: string, owner: string) {
    let t: Transfer;
    try { t = JSON.parse(await readFile(this.path(id), "utf8")); }
    catch (e) { if (e instanceof TransferError) throw e; throw new TransferError(404, "Upload expired. Select the file again."); }
    if (t.owner !== owner) throw new TransferError(404, "Upload not found");
    if (t.expires < this.now()) throw new TransferError(410, "Upload expired. Select the file again.");
    return t;
  }
  async sweep() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.root);
    const active: Transfer[] = [];
    for (const entry of entries.filter(x => x.endsWith(".json"))) {
      const id = entry.slice(0, -5);
      const t = JSON.parse(await readFile(this.path(id), "utf8")) as Transfer;
      if (t.expires < this.now()) {
        await unlink(this.path(id, ".part")).catch(() => {});
        await unlink(this.path(id));
      } else active.push(t);
    }
    // A crash between creating a partial/journal temp and publishing its
    // manifest must not leave unaccounted disk usage forever.
    for (const entry of entries.filter(x => /\.(part|new)$/.test(x))) {
      const id = entry.replace(/\.(part|new)$/, "");
      if (!entries.includes(id + ".json")) {
        const path = join(this.root, entry);
        if ((await stat(path)).mtimeMs + LIFETIME < this.now()) await unlink(path);
      }
    }
    return active;
  }
  async begin(id: string, owner: string, body: { name?: unknown; type?: unknown; size?: unknown }) {
    this.path(id);
    if (typeof body.name !== "string" || body.name.length > 512 || typeof body.type !== "string" || body.type.length > 128 || !Number.isSafeInteger(body.size) || (body.size as number) < 0) throw new TransferError(400, "Invalid file details");
    if ((body.size as number) > MAX_UPLOAD_BYTES) throw new TransferError(413, "Files can be up to 32 MB");
    const active = await this.sweep();
    await sweepOldUploads(this.now, this.dir);
    let existing: Transfer | undefined;
    try { existing = await this.load(id, owner); } catch (e) { if (!(e instanceof TransferError) || e.status !== 404) throw e; }
    // Never replace another owner's ID, even though lookup deliberately hides it.
    if (!existing && await stat(this.path(id)).then(() => true, () => false)) throw new TransferError(409, "Upload ID is already in use");
    if (existing) {
      if (existing.name !== safeName(body.name) || existing.type !== body.type || existing.size !== body.size) throw new TransferError(409, "File details changed");
      return this.status(id, owner);
    }
    if (await stat(join(this.dir, `${id}_${safeName(body.name)}`)).then(() => true, () => false)) throw new TransferError(410, "Upload receipt expired. Select the file again.");
    const partial = active.filter(t => !t.result);
    if (active.length >= 128 || partial.length >= 2 || partial.some(t => t.owner === owner)) throw new TransferError(429, "Another file is uploading. Try again shortly.");
    const t: Transfer = { owner, name: safeName(body.name), type: body.type, size: body.size as number, offset: 0, expires: this.now() + LIFETIME };
    const f = await open(this.path(id, ".part"), "w", 0o600); await f.close();
    await this.save(id, t);
    return { offset: 0 };
  }
  async status(id: string, owner: string) {
    const t = await this.load(id, owner);
    if (t.digest && !t.result) return this.finish(id, owner, t.digest);
    return { offset: t.offset, result: t.result };
  }
  async chunk(id: string, owner: string, offset: number, bytes: Uint8Array) {
    const t = await this.load(id, owner);
    if (!Number.isSafeInteger(offset) || offset < 0 || !bytes.length || bytes.length > TRANSFER_CHUNK || offset + bytes.length > t.size) throw new TransferError(400, "Invalid file chunk");
    if (t.digest || t.result) throw new TransferError(409, "Upload already finalized");
    if (offset > t.offset || (offset < t.offset && offset + bytes.length > t.offset)) throw new TransferError(409, "Upload offset changed");
    const f = await open(this.path(id, ".part"), "r+");
    try {
      if (offset < t.offset) {
        const previous = new Uint8Array(bytes.length);
        const read = await f.read(previous, 0, previous.length, offset);
        if (read.bytesRead !== bytes.length || !Buffer.from(previous).equals(Buffer.from(bytes))) throw new TransferError(409, "File changed while uploading");
      } else {
        await f.truncate(t.offset);
        let written = 0;
        while (written < bytes.length) {
          const result = await f.write(bytes, written, bytes.length - written, offset + written);
          if (!result.bytesWritten) throw new Error("Disk write failed");
          written += result.bytesWritten;
        }
        await f.sync();
        t.offset += bytes.length;
        await this.save(id, t);
      }
    } finally { await f.close(); }
    return { offset: t.offset };
  }
  async finish(id: string, owner: string, digest: string): Promise<{ offset: number; result: StoredUpload }> {
    const t = await this.load(id, owner);
    if (!/^[a-f0-9]{64}$/.test(digest) || t.offset !== t.size || (t.digest && t.digest !== digest)) throw new TransferError(409, "File is incomplete or changed");
    if (t.result) return { offset: t.offset, result: t.result };
    const destination = join(this.dir, `${id}_${t.name}`);
    const alreadyMoved = !!t.digest && await stat(destination).then(() => true, () => false);
    if (!alreadyMoved) {
      const hash = createHash("sha256");
      for await (const part of Bun.file(this.path(id, ".part")).stream()) hash.update(part);
      if (hash.digest("hex") !== digest) throw new TransferError(409, "File changed while uploading. Select it again.");
      t.digest = digest;
      await this.save(id, t);
      await rename(this.path(id, ".part"), destination);
    }
    t.result = { path: destination, name: t.name, type: t.type, size: t.size };
    await this.save(id, t);
    return { offset: t.offset, result: t.result };
  }
  async cancel(id: string, owner: string) {
    const t = await this.load(id, owner);
    // Completed attachments can already be in a conversation. Never delete them.
    if (!t.result && !t.digest) {
      await unlink(this.path(id, ".part")).catch(() => {});
      await unlink(this.path(id));
    }
    return { ok: true };
  }
}
