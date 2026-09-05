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

const PREFIX = "shahi://pair#";

export function parsePairingUrl(data: string): PairingPayload | null {
  let text = data.trim();
  if (text.length > 8192) return null;
  const hosted = "https://getshahi.dev/pwa/#pair=";
  if (text.startsWith(hosted)) {
    try { text = decodeURIComponent(text.slice(hosted.length)); } catch { return null; }
  }
  if (!text.startsWith(PREFIX)) return null;

  const fields = new Map<string, string>();
  for (const pair of text.slice(PREFIX.length).split("&")) {
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
  if (!isBaseUrl(relay)) return null;

  return { v: 1, server, relay: relay.replace(/\/+$/, ""), secret };
}

const isBaseUrl = (s: string): boolean => {
  try {
    if (/\s/.test(s)) return false;
    const url = new URL(s);
    return (url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) &&
      !url.username && !url.password && !url.search && !url.hash && url.pathname === "/";
  } catch { return false; }
};

/** `URLSearchParams` encodes a space as `+`; `decodeURIComponent` does not know that. */
const decode = (s: string) => decodeURIComponent(s.replace(/\+/g, " "));
