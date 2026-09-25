/**
 * Why a file could not be fetched or shown, in words meant for the person.
 *
 * Clients show its message as it stands and describe every other failure (no
 * connection, a timeout) themselves. The native viewer used to show only
 * messages beginning "Preview unavailable" and replace the rest with "It may
 * have moved, or your computer may be offline", which was wrong for a folder,
 * a file outside home, a file over the ceiling and an out-of-date computer
 * alike (September 2026 pre-release bug hunt).
 */
export class FileDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileDownloadError";
  }
}

const MAXIMUM = 25 * 1024 * 1024;
const TOO_LARGE = "This file is over 25 MB, which is too large to open or download through Shahi. Open it on your computer.";
const NEEDS_UPDATE = "This computer needs an update to download larger files through the relay.";

/**
 * Whether a 413 is the file's own 25 MiB ceiling rather than the relay's frame
 * limit. Current computers say so with a code; every earlier one words its
 * ceiling as "file is <n> bytes, over the <n> limit".
 */
export function overFileCeiling(body: unknown): boolean {
  const { error, code } = (typeof body === "object" && body !== null ? body : {}) as { error?: unknown; code?: unknown };
  return code === "file_too_large" || (typeof error === "string" && /^file is \d+ bytes, over the \d+ limit$/.test(error));
}

/**
 * What to tell the person when `/api/file` answered with a refusal.
 *
 * Two refusals share 413. Every computer answers 413 for a file over the
 * ceiling, and that one is final; the relay answers 413 when a whole file will
 * not fit in one sealed frame, which a ranged download only meets on a
 * computer that predates ranges. Every 413 used to say "needs an update",
 * even for a current computer, and even over SSH where no relay is involved.
 */
export function fileRefusal(status: number, body: unknown): string {
  if (status === 413) return overFileCeiling(body) ? TOO_LARGE : NEEDS_UPDATE;
  if (status === 409) return "The file changed while downloading. Try again.";
  const error = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
  // Folder, outside home, missing: the computer's own words, which name the
  // problem where this client cannot.
  if ((status === 400 || status === 403 || status === 404) && typeof error === "string" && error) return error;
  return "The file could not be downloaded. Check your connection and try again.";
}

type FileResponse = { ok: boolean; status: number; headers: Headers; bytes(): Promise<Uint8Array> };

async function refused(response: FileResponse): Promise<FileDownloadError> {
  let body: unknown = null;
  try { body = JSON.parse(new TextDecoder().decode(await response.bytes())); } catch { /* No reason given. */ }
  return new FileDownloadError(fileRefusal(response.status, body));
}

/**
 * The whole file in one answer, the way computers before ranged downloads sent
 * it: small files fit in one relay frame, and larger ones come back as the
 * relay's 413, which says the computer needs an update.
 */
async function wholeFile(request: (headers: Record<string, string>) => Promise<FileResponse>): Promise<{ bytes: Uint8Array; contentType: string }> {
  const response = await request({});
  if (!response.ok) throw await refused(response);
  if (response.status !== 200) throw new FileDownloadError("The computer returned an incomplete file.");
  const bytes = await response.bytes();
  if (bytes.length > MAXIMUM) throw new FileDownloadError(TOO_LARGE);
  return { bytes, contentType: response.headers.get("content-type") ?? "application/octet-stream" };
}

/** Sequential bounded ranges keep PDFs/downloads inside encrypted relay frames. */
export async function downloadFileBytes(
  request: (headers: Record<string, string>) => Promise<FileResponse>,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const chunk = 512 * 1024;
  let offset = 0, total: number | undefined, version: string | undefined;
  let contentType = "application/octet-stream";
  const parts: Uint8Array[] = [];
  do {
    const response = await request({ range: `bytes=${offset}-${offset + chunk - 1}`, ...(version ? { "x-shahi-file-version": version } : {}) });
    if (!response.ok) throw await refused(response);
    if (!offset) contentType = response.headers.get("content-type") ?? contentType;
    const bytes = await response.bytes();
    if (response.status === 200 && offset === 0) {
      if (bytes.length > MAXIMUM) throw new FileDownloadError(TOO_LARGE);
      return { bytes, contentType };
    }
    const match = response.headers.get("content-range")?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    const currentVersion = response.headers.get("x-shahi-file-version");
    // Shahi 0.3.6, on Stable from 20 to 24 September 2026, answered ranges
    // with 206 but its relay client passed on only content-type, etag and
    // cache-control, so the range and version never arrived and every file,
    // 584 bytes or 20 MB, failed as "incomplete". Asked again without a
    // range it answers as older computers do.
    if (offset === 0 && response.status === 206 && (!match || !currentVersion)) return wholeFile(request);
    if (!match || response.status !== 206 || !currentVersion) throw new FileDownloadError("The computer returned an incomplete file.");
    const start = Number(match[1]), end = Number(match[2]), size = Number(match[3]);
    if (start !== offset || end < start || end - start + 1 !== bytes.length || bytes.length > chunk || size > MAXIMUM || size <= end || !Number.isSafeInteger(size) || (total !== undefined && size !== total) || (version && currentVersion !== version)) throw new FileDownloadError("The file changed or could not be downloaded completely. Try again.");
    total = size; version = currentVersion; parts.push(bytes); offset += bytes.length;
  } while (total === undefined || offset < total);
  const bytes = new Uint8Array(total);
  let position = 0; for (const part of parts) { bytes.set(part, position); position += part.length; }
  return { bytes, contentType };
}
