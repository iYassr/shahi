import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, readFile, appendFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { UploadTransfers, TRANSFER_CHUNK } from "./upload-transfers";
import { uploadFile, type UploadRequest } from "../../shared/src/file-upload";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const id = "test-transfer-00000001";
const owner = "test-device";
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function setup(now?: () => number) { const dir = await mkdtemp(join(tmpdir(), "shahi-chunks-")); dirs.push(dir); return { dir, store: new UploadTransfers(dir, now) }; }

test("32 MiB streams through bounded chunks and finalization is idempotent", async () => {
  const { dir, store } = await setup();
  const size = 32 * 1024 * 1024;
  const chunk = new Uint8Array(TRANSFER_CHUNK).fill(61), hash = createHash("sha256");
  await store.begin(id, owner, { name: "../sample.bin", type: "application/octet-stream", size });
  for (let offset = 0; offset < size; offset += chunk.length) {
    hash.update(chunk); expect((await store.chunk(id, owner, offset, chunk)).offset).toBe(offset + chunk.length);
  }
  const sum = hash.digest("hex"), result = await store.finish(id, owner, sum);
  expect(result.result.name).toBe("sample.bin");
  expect((await readFile(result.result.path)).length).toBe(size);
  expect(digest(await readFile(result.result.path))).toBe(sum);
  expect(await new UploadTransfers(dir).finish(id, owner, sum)).toEqual(result);
  expect((await readdir(dir)).filter(x => x.endsWith(".bin"))).toHaveLength(1);
}, 30_000);

test("lost chunk receipts, process restart and uncommitted disk bytes do not duplicate data", async () => {
  const { dir, store } = await setup();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  await store.begin(id, owner, { name: "sample", type: "", size: 4 });
  await store.chunk(id, owner, 0, bytes.slice(0, 2));
  await appendFile(join(dir, ".transfers", id + ".part"), new Uint8Array([9, 9]));
  const restarted = new UploadTransfers(dir);
  expect(await restarted.chunk(id, owner, 0, bytes.slice(0, 2))).toEqual({ offset: 2 });
  await restarted.chunk(id, owner, 2, bytes.slice(2));
  const result = await restarted.finish(id, owner, digest(bytes));
  expect(new Uint8Array(await readFile(result.result.path))).toEqual(bytes);
});

test("ownership, offset, chunk size, quota and complete-file hash are enforced", async () => {
  const { store } = await setup();
  await expect(store.begin(id, owner, { name: "large", type: "", size: 32 * 1024 * 1024 + 1 })).rejects.toMatchObject({ status: 413 });
  await store.begin(id, owner, { name: "sample", type: "", size: 4 });
  await expect(store.status(id, "other")).rejects.toMatchObject({ status: 404 });
  await expect(store.cancel(id, "other")).rejects.toMatchObject({ status: 404 });
  // Two phones uploading fill the computer; a third waits.
  await store.begin("second-transfer-0001", "second-device", { name: "sample", type: "", size: 4 });
  await expect(store.begin("third-transfer-00001", "third-device", { name: "sample", type: "", size: 0 })).rejects.toMatchObject({ status: 429 });
  await expect(store.chunk(id, owner, 2, new Uint8Array([1]))).rejects.toMatchObject({ status: 409 });
  await expect(store.chunk(id, owner, 0, new Uint8Array(TRANSFER_CHUNK + 1))).rejects.toMatchObject({ status: 400 });
  await store.chunk(id, owner, 0, new Uint8Array([1, 2, 3, 4]));
  await expect(store.chunk(id, owner, 0, new Uint8Array([9, 2]))).rejects.toMatchObject({ status: 409 });
  await expect(store.finish(id, owner, "0".repeat(64))).rejects.toMatchObject({ status: 409 });
  await store.cancel(id, owner);
  await expect(store.status(id, owner)).rejects.toMatchObject({ status: 404 });
});

test("expired partial files are removed and empty files finalize", async () => {
  let now = 1;
  const { store, dir } = await setup(() => now);
  await store.begin(id, owner, { name: "empty", type: "", size: 0 });
  const completed = await store.finish(id, owner, digest(new Uint8Array()));
  await store.begin("partial-transfer-00001", owner, { name: "partial", type: "", size: 100 });
  now += 3_600_001; await store.sweep();
  expect(await readdir(join(dir, ".transfers"))).toEqual([]);
  expect((await readFile(completed.result.path)).length).toBe(0);
  await expect(store.begin(id, owner, { name: "empty", type: "", size: 0 })).rejects.toMatchObject({ status: 410 });
});

test("shared uploader recovers a lost acknowledgment and final reply without duplicate files", async () => {
  const { store, dir } = await setup();
  let dropChunk = true, dropFinal = true, maxRead = 0;
  const bytes = new Uint8Array(TRANSFER_CHUNK * 2 + 3).fill(28);
  const request: UploadRequest = async (path, init) => {
    const result = await store.run(async () => {
      if (init.method === "DELETE") return store.cancel(id, owner);
      if (path.endsWith("/chunk")) return store.chunk(id, owner, Number(init.headers?.["x-upload-offset"]), init.body as Uint8Array);
      if (path.endsWith("/finish")) return store.finish(id, owner, JSON.parse(init.body as string).digest);
      return store.begin(id, owner, JSON.parse(init.body as string));
    });
    if (path.endsWith("/chunk") && dropChunk) { dropChunk = false; throw new Error("connection lost"); }
    if (path.endsWith("/finish") && dropFinal) { dropFinal = false; throw new Error("connection lost"); }
    return { ok: true, status: 200, json: async () => result };
  };
  const result = await uploadFile(request, id, { name: "sample.bin", type: "", size: bytes.length, read: async (offset, count) => { maxRead = Math.max(maxRead, count); return bytes.slice(offset, offset + count); } }, { maxBytes: 32 * 1024 * 1024, chunkBytes: TRANSFER_CHUNK });
  expect(maxRead).toBe(TRANSFER_CHUNK);
  expect(new Uint8Array(await readFile(result.path))).toEqual(bytes);
  expect((await readdir(dir)).filter(x => x.endsWith(".bin"))).toHaveLength(1);
});


test("cancelling stops subsequent reads and removes the partial upload", async () => {
  const { store } = await setup();
  const controller = new AbortController(); let reads = 0;
  const request: UploadRequest = async (path, init) => {
    const result = await store.run(async () => {
      if (init.method === "DELETE") return store.cancel(id, owner);
      if (path.endsWith("/chunk")) return store.chunk(id, owner, Number(init.headers?.["x-upload-offset"]), init.body as Uint8Array);
      return store.begin(id, owner, JSON.parse(init.body as string));
    });
    return { ok: true, status: 200, json: async () => result };
  };
  await expect(uploadFile(request, id, { name: "cancelled.bin", type: "", size: 131072, read: async (_offset,count) => { reads++; return new Uint8Array(count); } }, { maxBytes: 33554432, chunkBytes: TRANSFER_CHUNK }, { signal: controller.signal, onProgress: sent => { if (sent) controller.abort(); } })).rejects.toThrow("cancelled");
  await store.run(async () => {});
  expect(reads).toBe(1);
  await expect(store.status(id, owner)).rejects.toMatchObject({ status: 404 });
});

/** The shared uploader against this store, as one phone; `lost` drops every cancel on the way. */
function phone(store: UploadTransfers, who: string, lost = false): UploadRequest {
  return async (path, init) => {
    const transfer = path.match(/transfers\/([^/]+)/)![1]!;
    if (init.method === "DELETE" && lost) throw new Error("connection lost");
    const result = await store.run(async () => {
      if (init.method === "DELETE") return store.cancel(transfer, who);
      if (path.endsWith("/chunk")) return store.chunk(transfer, who, Number(init.headers?.["x-upload-offset"]), init.body as Uint8Array);
      if (path.endsWith("/finish")) return store.finish(transfer, who, JSON.parse(init.body as string).digest);
      return store.begin(transfer, who, JSON.parse(init.body as string));
    }).catch((e: { status?: number; message: string }) => ({ failed: e.status ?? 500, error: e.message }));
    const status = "failed" in result ? result.failed : 200;
    return { ok: status === 200, status, json: async () => result };
  };
}

// Review finding F39: the app killed mid-upload, or its cancel lost with the
// connection, left a partial that refused this phone for the rest of the hour.
test("an upload interrupted before its cancel arrived does not block the phone's next upload", async () => {
  const { store } = await setup();
  const limits = { maxBytes: 32 * 1024 * 1024, chunkBytes: TRANSFER_CHUNK };
  const bytes = new Uint8Array(TRANSFER_CHUNK * 2).fill(7);
  const source = { name: "photo.jpg", type: "image/jpeg", size: bytes.length, read: async (offset: number, count: number) => bytes.slice(offset, offset + count) };
  const killed = new AbortController();
  await expect(uploadFile(phone(store, owner, true), "stranded-transfer-01", source, limits, { signal: killed.signal, onProgress: sent => { if (sent) killed.abort(); } })).rejects.toThrow("cancelled");
  expect((await store.status("stranded-transfer-01", owner)).offset).toBe(TRANSFER_CHUNK);

  const retried = await uploadFile(phone(store, owner), "reselected-transfer1", source, limits);
  expect(new Uint8Array(await readFile(retried.path))).toEqual(bytes);
  // Its predecessor is gone, partial bytes and all.
  await expect(store.status("stranded-transfer-01", owner)).rejects.toMatchObject({ status: 404 });
});

test("another phone's stranded upload gives up its place on a full computer once it stops moving", async () => {
  let now = 1_000;
  const { store } = await setup(() => now);
  await store.begin("first-phone-transfer", "first", { name: "a", type: "", size: 2 });
  await store.begin("second-phone-transfer", "second", { name: "b", type: "", size: 2 });
  now += 9 * 60_000;
  // Still moving: a chunk nine minutes in keeps the first phone's place.
  await store.chunk("first-phone-transfer", "first", 0, new Uint8Array([1]));
  await expect(store.begin("third-phone-transfer", "third", { name: "c", type: "", size: 1 })).rejects.toMatchObject({ status: 429 });
  now += 2 * 60_000;
  expect(await store.begin("third-phone-transfer", "third", { name: "c", type: "", size: 1 })).toEqual({ offset: 0 });
  // The idle one went; the one that moved stayed.
  await expect(store.status("second-phone-transfer", "second")).rejects.toMatchObject({ status: 404 });
  expect((await store.status("first-phone-transfer", "first")).offset).toBe(1);
});

// A revoked or signed-out owner's unfinished uploads go at once; what it
// finished may already be in a conversation, and other owners are untouched.
test("discarding a revoked owner's uploads keeps its finished files and everyone else's", async () => {
  const { store, dir } = await setup();
  await store.begin("finished-transfer-01", owner, { name: "done", type: "", size: 0 });
  const done = await store.finish("finished-transfer-01", owner, digest(new Uint8Array()));
  await store.begin("unfinished-transfer1", owner, { name: "partial", type: "", size: 10 });
  await store.begin("someone-elses-upload", "other", { name: "theirs", type: "", size: 10 });
  await store.run(() => store.discardOwner(owner));
  await expect(store.status("unfinished-transfer1", owner)).rejects.toMatchObject({ status: 404 });
  expect((await readdir(join(dir, ".transfers"))).filter(x => x.startsWith("unfinished-"))).toEqual([]);
  expect((await store.status("finished-transfer-01", owner)).result).toEqual(done.result);
  expect((await store.status("someone-elses-upload", "other")).offset).toBe(0);
  // A computer that never received an upload has nothing to discard, and no directory is made.
  const fresh = new UploadTransfers(join(dir, "never-used"));
  await fresh.discardOwner(owner);
  expect(await readdir(dir)).not.toContain("never-used");
});
