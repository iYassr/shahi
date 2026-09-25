/**
 * Reads a pairing code off a scanned QR.
 *
 * The code is `shahi://pair#v=1&server=…&relay=…&secret=…` — the server's
 * `pairingUrl` writes it and this is its inverse. Parsed by hand rather than
 * with `URL`, because a fragment is the one part of a URL every parser treats
 * as opaque, and because anything short of a full parse must answer null: a
 * code that is nearly right is somebody else's QR, not ours.
 */
import type { PairingPayload } from "./index";

/**
 * What follows a code's scheme and host, or null when it has neither.
 *
 * A scheme and a host are case-insensitive (RFC 3986 §3.1, §3.2.2): iOS hands
 * `SHAHI://pair#…` to the app like the lower-case link, and it was dropped
 * without a word (pre-release bug hunt). The hosted path and the fragment are
 * compared exactly.
 */
function afterPrefix(text: string, origin: string, rest: string): string | null {
  if (text.slice(0, origin.length).toLowerCase() !== origin || !text.startsWith(rest, origin.length)) return null;
  return text.slice(origin.length + rest.length);
}

export function parsePairingUrl(data: string): PairingPayload | null {
  let text = data.trim();
  if (text.length > 8192) return null;
  const hosted = afterPrefix(text, "https://getshahi.dev", "/pwa/#pair=");
  if (hosted !== null) {
    try { text = decodeURIComponent(hosted); } catch { return null; }
  }
  const code = afterPrefix(text, "shahi://pair", "#");
  if (code === null) return null;

  const fields = new Map<string, string>();
  for (const pair of code.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) return null;
    try {
      const key = decode(pair.slice(0, eq));
      if (fields.has(key)) return null;
      fields.set(key, decode(pair.slice(eq + 1)));
    } catch {
      return null; // a bad escape sequence
    }
  }

  const server = fields.get("server");
  const secret = fields.get("secret");
  const relay = fields.get("relay");
  if (fields.get("v") !== "1" || !server || !relay || !secret) return null;
  if (!/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(server) ||
      !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(secret)) return null;
  // The relay is the whole address now, so a code without a usable one is a
  // code with nowhere to go — null, not a partial payload to be repaired later.
  const origin = relayOrigin(relay);
  if (!origin) return null;

  return { v: 1, server, relay: origin, secret };
}

/**
 * The relay as it will be dialled — its origin — or null when it is not one.
 *
 * Only an ASCII origin is accepted, because the pairing card shows this host
 * as the thing the person agrees to. A Unicode host can copy another letter
 * for letter — `relаy.getshahi.dev` with a Cyrillic "а" — and the card showed
 * exactly that while iOS dialled `xn--rely-73d.getshahi.dev` (pre-release bug
 * hunt). A browser's `URL` turns such a host into its `xn--` form, which is
 * then what is shown; the app's, Expo's whatwg-url-minimum, has no IDNA and
 * leaves it Unicode, so there the code is refused. An international relay
 * domain belongs in RELAY_URL in its `xn--` form.
 */
const relayOrigin = (s: string): string | null => {
  try {
    if (/\s/.test(s)) return null;
    const url = new URL(s);
    const allowed = (url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) &&
      !url.username && !url.password && !url.search && !url.hash && url.pathname === "/";
    return allowed && /^[\x21-\x7e]+$/.test(url.origin) ? url.origin : null;
  } catch { return null; }
};

/** `URLSearchParams` encodes a space as `+`; `decodeURIComponent` does not know that. */
const decode = (s: string) => decodeURIComponent(s.replace(/\+/g, " "));
