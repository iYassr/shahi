import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { StoredUpload } from "./index";

export interface UploadOptions { signal?: AbortSignal; onProgress?: (sent: number, total: number) => void }
export interface UploadSource { name: string; type: string; size: number; read(offset: number, count: number): Promise<Uint8Array> }
interface Reply { ok: boolean; status: number; json(): Promise<unknown> }
export type UploadRequest = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array }) => Promise<Reply>;
class UploadError extends Error { constructor(message: string, public status: number) { super(message); } }

/** A capability lookup leaves old computers usable without guessing their limits. */
export async function uploadCapability(request: UploadRequest): Promise<{ maxBytes: number; chunkBytes: number } | null> {
  const res = await request("/api/uploads/limits", {});
  if (res.status === 404 || res.status === 405) return null;
  const body = await res.json() as { version?: number; maxBytes?: number; chunkBytes?: number; error?: string };
  if (!res.ok) throw new UploadError(body.error ?? "Could not check the file limit", res.status);
  if (body.version !== 1) return null;
  if (!Number.isSafeInteger(body.maxBytes) || body.maxBytes! <= 0 || body.maxBytes! > 32 * 1024 * 1024 || !Number.isSafeInteger(body.chunkBytes) || body.chunkBytes! <= 0 || body.chunkBytes! > 64 * 1024) throw new Error("Invalid upload capability");
  return { maxBytes: body.maxBytes!, chunkBytes: body.chunkBytes! };
}

/** Retry only idempotent transfer operations, never the message that uses the file.
 * Each chunk is read once and retained until acknowledged; reconnects seal a new
 * request with the same offset, not a replay of an encrypted frame. */
export async function uploadFile(request: UploadRequest, id: string, source: UploadSource, limits: { maxBytes: number; chunkBytes: number }, options: UploadOptions = {}): Promise<StoredUpload> {
  if (!Number.isSafeInteger(source.size) || source.size < 0 || source.size > limits.maxBytes) throw new Error("Files can be up to 32 MB");
  const path = `/api/uploads/transfers/${id}`;
  const deadline = Date.now() + 55 * 60_000;
  const check = () => {
    if (options.signal?.aborted) throw new Error("Upload cancelled");
    if (Date.now() > deadline) throw new Error("Upload took too long. Try again on a better connection.");
  };
  async function send(url: string, init: Parameters<UploadRequest>[1]) {
    const retryUntil = Date.now() + 120_000;
    let delay = 500;
    while (true) {
      check();
      try {
        const res = await request(url, init);
        const body = await res.json() as { error?: string; offset?: number; result?: StoredUpload };
        if (!res.ok) throw new UploadError(body.error ?? "Could not upload this file", res.status);
        check();
        return body;
      } catch (e) {
        if (e instanceof UploadError && (!([429, 502, 503, 504].includes(e.status)) || (e.status === 429 && url === path && init.method === "PUT"))) throw e;
        if (e instanceof Error && ["AbortError", "UnauthorizedError", "IncompatibleServerError"].includes(e.name)) throw e;
        check();
        if (Date.now() >= retryUntil) throw new Error("The connection was lost. Try uploading again.");
        await new Promise<void>(resolve => setTimeout(resolve, delay));
        delay = Math.min(8000, delay * 2);
      }
    }
  }
  const json = (value: object) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  try {
    await send(path, { method: "PUT", ...json({ name: source.name, type: source.type, size: source.size }) });
    const hash = sha256.create();
    options.onProgress?.(0, source.size);
    for (let offset = 0; offset < source.size;) {
      check();
      const count = Math.min(limits.chunkBytes, source.size - offset);
      const bytes = await source.read(offset, count);
      if (bytes.length !== count) throw new Error("The file changed while uploading. Select it again.");
      hash.update(bytes);
      const ack = await send(path + "/chunk", { method: "PUT", headers: { "content-type": "application/octet-stream", "x-upload-offset": String(offset) }, body: bytes });
      offset += count;
      if (ack.offset !== offset) throw new Error("The computer returned an invalid upload receipt");
      options.onProgress?.(offset, source.size);
    }
    const final = await send(path + "/finish", { method: "POST", ...json({ digest: bytesToHex(hash.digest()) }) });
    if (!final.result?.path || final.result.size !== source.size) throw new Error("The computer returned an incomplete upload");
    return final.result;
  } catch (error) {
    // Expiry is the fallback when the computer is offline. Cleanup must not
    // keep the user's error/cancellation waiting on another request deadline.
    void request(path, { method: "DELETE" }).catch(() => {});
    throw error;
  }
}
