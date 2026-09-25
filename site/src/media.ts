/**
 * /media/<name>: the launch video, its poster and captions, read from the R2
 * bucket bound as MEDIA. They are not static assets because those answer
 * `Range` with the whole file as a 200 and no Accept-Ranges (measured
 * 2026-09-25 in wrangler 4.129 and on getshahi.dev): Chrome then cannot seek,
 * its `seekable` stayed empty and a jump to 0:25 landed on 0:00, and WebKit,
 * which opens every video with a `bytes=0-1` probe, downloads all of it. R2
 * reads a range and the preconditions from the request's own headers and
 * streams only those bytes, so nothing here buffers a file.
 *
 * They are not in git either: the repository is what every
 * `herdr plugin install` clones, and the video would double it.
 * marketing/video/scripts/publish-media.ts encodes, names and uploads them.
 *
 * site/public/_headers applies only to what static assets serve, never to a
 * Worker's response, so every header a /media response needs is set here.
 */

// `<stem>.<first 8 hex of the file's sha256>.<ext>`, as the publish script
// names them (site/media.test.ts holds site/media.json to it). A new cut is a
// new URL, which is what makes a year of `immutable` safe. The pattern admits
// no `/`, `.` segment or escape, so it is also the whole path-traversal guard.
// Its length bound keeps a name well under R2's 1,024-byte key limit, past
// which bucket.get() throws (error 10020) and the request failed with a 500.
// The real names are 24 to 26 characters.
export const MEDIA_NAME = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*\.[0-9a-f]{8}\.(mp4|jpg|en\.vtt)$/;

const TYPES: Record<string, string> = {
  "mp4": "video/mp4",
  "jpg": "image/jpeg",
  "en.vtt": "text/vtt; charset=utf-8",
};

/** The Content-Type a /media name is served with, or undefined if it is not one. */
export function mediaType(name: string): string | undefined {
  const extension = MEDIA_NAME.exec(name)?.[1];
  return extension === undefined ? undefined : TYPES[extension];
}

const SHARED = { "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" };
// workerd's R2 binding throws a plain Error (not a TypeError) on an If-Match or
// If-None-Match it cannot parse ("Invalid ETag in if-none-match header"), before
// R2 is asked, and head() then succeeds (measured, wrangler 4.129): a 500
// without a Range header, a false 416 with one. So the header is refused here,
// and the catch below sees only R2's own failures.
const ETAGS = /^(?:\*|(?:W\/)?"[^"]*"(?:\s*,\s*(?:W\/)?"[^"]*")*)$/;
const IMMUTABLE = "public, max-age=31536000, immutable";

function refuse(status: number, extra: Record<string, string> = {}): Response {
  // An error must not be cached for the year a hit is.
  return new Response(status === 404 ? "Not found\n" : null, {
    status, headers: { ...SHARED, "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8", ...extra },
  });
}

/**
 * Where the one byte range a request names starts, or undefined to serve the
 * whole file. Media elements send `bytes=0-1` (WebKit's first probe) and
 * `bytes=<n>-` (a seek); a suffix such as `bytes=-500` ends at the end, so it
 * always starts in the file. Several ranges, other units and nonsense are
 * ignored, which RFC 9110 §14.2 allows. This is decided here, not by R2:
 * local R2 (miniflare, wrangler 4.129) answered each of those, and a range
 * starting past the end, with the whole file while still reporting a range,
 * so every one of them became a 206 carrying the whole file.
 */
function rangeStart(header: string | null): number | undefined {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header ?? "");
  if (!match) return undefined;
  const [, first = "", last = ""] = match;
  if (first === "") return last === "" || Number(last) === 0 ? undefined : 0;
  return last !== "" && Number(last) < Number(first) ? undefined : Number(first);
}

export async function media(request: Request, bucket: R2Bucket): Promise<Response> {
  const name = new URL(request.url).pathname.slice("/media/".length);
  const type = mediaType(name);
  if (type === undefined) return refuse(404);
  const get = request.method === "GET";
  if (!get && request.method !== "HEAD") return refuse(405, { Allow: "GET, HEAD" });

  // Range is defined for GET alone (RFC 9110 §14.2), so a HEAD reads none.
  const start = get ? rangeStart(request.headers.get("Range")) : undefined;
  const ranged = start !== undefined;
  if (["If-Match", "If-None-Match"].some((field) => {
    const value = request.headers.get(field)?.trim();
    return value !== undefined && value !== "" && !ETAGS.test(value);
  })) return refuse(400);
  let object: R2Object | R2ObjectBody | null;
  try {
    object = await bucket.get(name, { range: ranged ? request.headers : undefined, onlyIf: request.headers });
  } catch (error) {
    // R2's documented answer to a range it cannot satisfy is an error
    // (InvalidRange, 10039); local R2 returns the whole file instead, caught
    // below. Both become a 416, and only for a range that starts past the
    // end: any other failure, a passing outage on a valid seek included,
    // stays an error.
    if (!ranged) throw error;
    const head = await bucket.head(name);
    if (head === null) return refuse(404);
    if (start < head.size) throw error;
    return refuse(416, { "Content-Range": `bytes */${head.size}` });
  }
  if (object === null) return refuse(404);

  const headers = new Headers({
    ...SHARED, "Content-Type": type, "Cache-Control": IMMUTABLE, "Accept-Ranges": "bytes", "ETag": object.httpEtag,
  });
  if (!("body" in object)) {
    // A precondition failed. Browsers revalidate media only with
    // If-None-Match or If-Modified-Since, which answer 304. A request that
    // sends If-Match or If-Unmodified-Since at all is answered 412, even if
    // that one passed and the other failed: an approximation of RFC 9110
    // §13.2.2 that no media element's request can tell apart.
    const strict = request.headers.has("If-Match") || request.headers.has("If-Unmodified-Since");
    return strict ? refuse(412) : new Response(null, { status: 304, headers });
  }
  if (ranged && start >= object.size) {
    await object.body.cancel();
    return refuse(416, { "Content-Range": `bytes */${object.size}` });
  }

  let status = 200;
  let length = object.size;
  if (ranged && object.range) {
    // R2 reports what it read as an offset and a length; its `suffix` key is
    // present but undefined then (measured locally), so test the value.
    const range = object.range as { offset?: number; length?: number; suffix?: number };
    const offset = range.suffix === undefined ? range.offset ?? 0 : Math.max(0, object.size - range.suffix);
    length = range.length ?? object.size - offset;
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    status = 206;
  }
  headers.set("Content-Length", String(length));
  if (!get) {
    await object.body.cancel();
    return new Response(null, { status, headers });
  }
  return new Response(object.body, { status, headers });
}
