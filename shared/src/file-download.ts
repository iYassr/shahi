/** Sequential bounded ranges keep PDFs/downloads inside encrypted relay frames. */
export async function downloadFileBytes(
  request: (headers: Record<string, string>) => Promise<{ ok: boolean; status: number; headers: Headers; bytes(): Promise<Uint8Array> }>,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const chunk = 512 * 1024, maximum = 25 * 1024 * 1024;
  let offset = 0, total: number | undefined, version: string | undefined;
  let contentType = "application/octet-stream";
  const parts: Uint8Array[] = [];
  do {
    const response = await request({ range: `bytes=${offset}-${offset + chunk - 1}`, ...(version ? { "x-shahi-file-version": version } : {}) });
    if (!response.ok) throw new Error(response.status === 413 ? "This computer needs an update to download larger files through the relay." : response.status === 409 ? "The file changed while downloading. Try again." : "The file could not be downloaded. Check your connection and try again.");
    if (!offset) contentType = response.headers.get("content-type") ?? contentType;
    const bytes = await response.bytes();
    if (response.status === 200 && offset === 0) {
      if (bytes.length > maximum) throw new Error("This file is too large to download.");
      return { bytes, contentType };
    }
    const match = response.headers.get("content-range")?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    const currentVersion = response.headers.get("x-shahi-file-version");
    if (!match || response.status !== 206 || !currentVersion) throw new Error("The computer returned an incomplete file.");
    const start = Number(match[1]), end = Number(match[2]), size = Number(match[3]);
    if (start !== offset || end < start || end - start + 1 !== bytes.length || bytes.length > chunk || size > maximum || size <= end || !Number.isSafeInteger(size) || (total !== undefined && size !== total) || (version && currentVersion !== version)) throw new Error("The file changed or could not be downloaded completely. Try again.");
    total = size; version = currentVersion; parts.push(bytes); offset += bytes.length;
  } while (total === undefined || offset < total);
  const bytes = new Uint8Array(total);
  let position = 0; for (const part of parts) { bytes.set(part, position); position += part.length; }
  return { bytes, contentType };
}
