import { parsePairingUrl } from "./pairing";
import { redirectSystemPath } from "../app/+native-intent";
import { dismissPairing } from "./incoming-pairing";

const GOOD =
  "shahi://pair#v=1&server=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&relay=https%3A%2F%2Frelay.example.workers.dev&secret=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBI";

describe("parsePairingUrl", () => {
  test("reads every field of a code the server printed", () => {
    expect(parsePairingUrl(GOOD)).toEqual({
      v: 1,
      server: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      relay: "https://relay.example.workers.dev",
      secret: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBI",
    });
  });

  test("tolerates surrounding whitespace and a trailing slash on the relay", () => {
    const parsed = parsePairingUrl(`  ${GOOD.replace("workers.dev", "workers.dev%2F")}\n`);
    expect(parsed?.relay).toBe("https://relay.example.workers.dev");
  });

  test("a plain http relay with a port is fine — that is what one run locally looks like", () => {
    const parsed = parsePairingUrl(GOOD.replace("https%3A%2F%2Frelay.example.workers.dev", "http%3A%2F%2F127.0.0.1%3A8787"));
    expect(parsed?.relay).toBe("http://127.0.0.1:8787");
  });

  // The relay is the only address on a code now. A code that names one badly
  // has nowhere to go, and there is no second field to fall back to.
  test("a relay that is not an address makes the whole code invalid", () => {
    expect(parsePairingUrl(GOOD.replace("https%3A%2F%2Frelay.example.workers.dev", "relay.example.workers.dev"))).toBeNull();
    expect(parsePairingUrl(GOOD.replace("https%3A%2F%2Frelay.example.workers.dev", ""))).toBeNull();
  });

  // The address a phone once typed was dropped from the format when the direct
  // transport went. An old code carrying one names no relay, so it is refused
  // rather than half-read.
  test("a pre-relay code, which carried an endpoint instead, is refused", () => {
    expect(
      parsePairingUrl("shahi://pair#v=1&server=a&endpoint=https%3A%2F%2Fbox.tailnet.ts.net&secret=s"),
    ).toBeNull();
  });

  // iOS opens the app for SHAHI:// as for shahi://, and the code inside was
  // ignored without a word because the prefix was compared case by case.
  test("a pairing link with an upper-case scheme or host pairs like the lower-case one", () => {
    expect(parsePairingUrl(GOOD.replace("shahi://pair#", "SHAHI://PAIR#"))).toEqual(parsePairingUrl(GOOD));
    expect(parsePairingUrl(GOOD)).not.toBeNull();
    expect(redirectSystemPath({ path: GOOD.replace("shahi://pair#", "SHAHI://pair#"), initial: false })).toBe("/connect");
    dismissPairing();
  });

  // This runs under the app's own `URL`, Expo's whatwg-url-minimum, which has
  // no IDNA: a Cyrillic "а" stays Unicode in the host. The confirmation card
  // read "relаy.getshahi.dev" while iOS dialled xn--rely-73d.getshahi.dev.
  test("a look-alike international relay is refused rather than shown as the host it imitates", () => {
    expect(new URL("https://relаy.getshahi.dev").host).toBe("relаy.getshahi.dev"); // the app's URL, as on the phone
    expect(parsePairingUrl(GOOD.replace("relay.example.workers.dev", "rel%D0%B0y.getshahi.dev"))).toBeNull();
    expect(parsePairingUrl(GOOD.replace("relay.example.workers.dev", "rel%25D0%25B0y.getshahi.dev"))).toBeNull();
    // Its xn-- form is plain ASCII: what is shown is what is dialled.
    expect(parsePairingUrl(GOOD.replace("relay.example.workers.dev", "xn--rely-73d.getshahi.dev"))?.relay).toBe("https://xn--rely-73d.getshahi.dev");
  });

  // Somebody else's QR must be reported as not ours, never half-parsed into a
  // connection attempt.
  test("anything that is not a complete Shahi code is null", () => {
    expect(parsePairingUrl(GOOD.replace("shahi://pair#", "https://example.com/pair#"))).toBeNull();
    expect(parsePairingUrl(GOOD.replace("pair#", "pair?"))).toBeNull(); // query, not fragment
    expect(parsePairingUrl(GOOD.replace("v=1", "v=2"))).toBeNull();
    expect(parsePairingUrl("shahi://pair#v=1&server=a&secret=s")).toBeNull(); // no relay
    expect(parsePairingUrl(GOOD.replace("secret=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBI", "secret="))).toBeNull();
    expect(parsePairingUrl(GOOD.replace("secret=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBI", "secret=%E0%A4%A"))).toBeNull(); // bad escape
    expect(parsePairingUrl("WIFI:S:home;T:WPA;P:hunter2;;")).toBeNull();
    expect(parsePairingUrl("")).toBeNull();
  });
});
