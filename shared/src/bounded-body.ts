export class BodyLimitError extends Error {
  constructor() { super("body limit exceeded"); }
}

/** Enforce the limit while reading, including responses without Content-Length. */
export async function boundedBody(response: Response, limit: number): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new BodyLimitError();
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new BodyLimitError(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
