/**
 * The pairing parser as a browser runs it: this `URL` does IDNA, as the web
 * client's does. `mobile/src/lib/pairing.test.ts` runs the same parser under
 * the app's own `URL` (Expo's whatwg-url-minimum), which does not.
 */
import { expect, test } from "bun:test";
import { parsePairingUrl } from "./pairing";

const SERVER = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SECRET = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBI";
const code = (relay: string, prefix = "shahi://pair#") =>
  `${prefix}v=1&server=${SERVER}&relay=${encodeURIComponent(relay)}&secret=${SECRET}`;

// URI schemes and hosts are case-insensitive, and iOS opens the app for
// SHAHI:// like shahi://. The upper-case link was ignored without a word.
test("a pairing link with an upper-case scheme or host pairs like the lower-case one", () => {
  const expected = { v: 1 as const, server: SERVER, relay: "https://relay.getshahi.dev", secret: SECRET };
  expect(parsePairingUrl(code("https://relay.getshahi.dev", "SHAHI://pair#"))).toEqual(expected);
  expect(parsePairingUrl(code("https://relay.getshahi.dev", "Shahi://PAIR#"))).toEqual(expected);
  const hosted = `HTTPS://GetShahi.dev/pwa/#pair=${encodeURIComponent(code("https://relay.getshahi.dev"))}`;
  expect(parsePairingUrl(hosted)).toEqual(expected);
  // Only the scheme and host: the hosted page's path is not the app's.
  expect(parsePairingUrl(hosted.replace("/pwa/", "/PWA/"))).toBeNull();
});

// The card shows the relay's host as what the person agrees to. A Cyrillic
// "а" made it read relay.getshahi.dev while the phone dialled the xn-- host.
test("a look-alike international relay is shown as the xn-- host that is really dialled", () => {
  expect(parsePairingUrl(code("https://relаy.getshahi.dev"))?.relay).toBe("https://xn--rely-73d.getshahi.dev");
  expect(parsePairingUrl(code("https://RELAY.getshahi.dev:443/"))?.relay).toBe("https://relay.getshahi.dev");
});
