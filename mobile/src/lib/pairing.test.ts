import { parsePairingUrl } from "./pairing";

const GOOD =
  "shahi://pair#v=1&server=0c5e1b9c-6d4d-4a0f-9d5e-9f4a2b1c3d7e&relay=https%3A%2F%2Frelay.example.workers.dev&secret=abc_DEF-123";

describe("parsePairingUrl", () => {
  test("reads every field of a code the server printed", () => {
    expect(parsePairingUrl(GOOD)).toEqual({
      v: 1,
      server: "0c5e1b9c-6d4d-4a0f-9d5e-9f4a2b1c3d7e",
      relay: "https://relay.example.workers.dev",
      secret: "abc_DEF-123",
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

  // Somebody else's QR must be reported as not ours, never half-parsed into a
  // connection attempt.
  test("anything that is not a complete Shahi code is null", () => {
    expect(parsePairingUrl(GOOD.replace("shahi://pair#", "https://example.com/pair#"))).toBeNull();
    expect(parsePairingUrl(GOOD.replace("pair#", "pair?"))).toBeNull(); // query, not fragment
    expect(parsePairingUrl(GOOD.replace("v=1", "v=2"))).toBeNull();
    expect(parsePairingUrl("shahi://pair#v=1&server=a&secret=s")).toBeNull(); // no relay
    expect(parsePairingUrl(GOOD.replace("secret=abc_DEF-123", "secret="))).toBeNull();
    expect(parsePairingUrl(GOOD.replace("secret=abc_DEF-123", "secret=%E0%A4%A"))).toBeNull(); // bad escape
    expect(parsePairingUrl("WIFI:S:home;T:WPA;P:hunter2;;")).toBeNull();
    expect(parsePairingUrl("")).toBeNull();
  });
});
