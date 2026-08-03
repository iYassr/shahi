/**
 * Compression for everything text-shaped this server sends.
 *
 * Nothing was compressed before, which on a phone is the difference between a
 * dashboard and a wait: the app bundle went out as 614KB, and an open pane
 * pulled a 45KB transcript every 2.5 seconds — around 18KB a second, forever,
 * on whatever connection the phone happened to be on.
 *
 * Applied at the edge of the request handler rather than at each route, so
 * there is one place where this can be wrong. Responses that are already
 * encoded, empty, or not worth the CPU are passed straight through.
 */

/** Below this, the header overhead is most of what you saved. */
const MIN_BYTES = 1024;

const COMPRESSIBLE = [
  "text/",
  "application/json",
  "application/javascript",
  "application/manifest+json",
  "image/svg+xml",
];

/**
 * Compressed bytes for immutable assets, keyed by ETag.
 *
 * The app bundle is the same 614KB on every cold load and costs real time to
 * gzip. Hashed filenames make the key trivially correct: a different build is a
 * different URL.
 */
const cache = new Map<string, Uint8Array>();
const CACHE_LIMIT = 32;

function acceptsGzip(request: Request): boolean {
  return (request.headers.get("accept-encoding") ?? "").toLowerCase().includes("gzip");
}

export function worthCompressing(contentType: string | null, bytes: number): boolean {
  if (bytes > 0 && bytes < MIN_BYTES) return false;
  if (!contentType) return false;
  const type = contentType.toLowerCase();
  return COMPRESSIBLE.some((prefix) => type.startsWith(prefix));
}

/**
 * Returns the response gzipped, or the original where that would be pointless.
 *
 * `cacheKey` opts an asset into the byte cache; leave it undefined for anything
 * that changes.
 */
export async function compress(
  request: Request,
  response: Response,
  cacheKey?: string,
): Promise<Response> {
  if (response.status === 204 || response.status === 304) return response;
  if (response.headers.has("content-encoding")) return response;
  if (!acceptsGzip(request)) return response;

  const type = response.headers.get("content-type");
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (!worthCompressing(type, declared)) return response;

  const cached = cacheKey ? cache.get(cacheKey) : undefined;
  let body: Uint8Array;

  if (cached) {
    body = cached;
  } else {
    const raw = new Uint8Array(await response.arrayBuffer());
    if (raw.byteLength < MIN_BYTES) {
      // Rebuilt, because the body has now been read.
      return new Response(raw, { status: response.status, headers: response.headers });
    }
    body = Bun.gzipSync(raw);
    if (cacheKey) {
      if (cache.size >= CACHE_LIMIT) cache.clear();
      cache.set(cacheKey, body);
    }
  }

  const headers = new Headers(response.headers);
  headers.set("content-encoding", "gzip");
  headers.set("content-length", String(body.byteLength));
  // Caches and proxies must not hand a gzipped body to a client that did not
  // ask for one.
  headers.append("vary", "accept-encoding");

  return new Response(body, { status: response.status, headers });
}

/** Drops cached bytes — for tests, and for a rebuild landing under a running server. */
export function forgetCompressed(): void {
  cache.clear();
}
