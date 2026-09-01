import { parsePairingUrl } from "./pairing";

const GOOD =
  "shahi://pair#v=1&server=0c5e1b9c-6d4d-4a0f-9d5e-9f4a2b1c3d7e&endpoint=https%3A%2F%2Fbox.tailnet.ts.net&secret=abc_DEF-123";

describe("parsePairingUrl", () => {
  test("reads every field of a code the server printed", () => {
    expect(parsePairingUrl(GOOD)).toEqual({
      v: 1,
      server: "0c5e1b9c-6d4d-4a0f-9d5e-9f4a2b1c3d7e",
      endpoint: "https://box.tailnet.ts.net",
      secret: "abc_DEF-123",
    });
  });

  test("tolerates surrounding whitespace and a trailing slash on the endpoint", () => {
    const parsed = parsePairingUrl(`  ${GOOD.replace("ts.net", "ts.net%2F")}\n`);
    expect(parsed?.endpoint).toBe("https://box.tailnet.ts.net");
  });

  test("a plain http endpoint with a port is fine — that is what a tailnet address looks like", () => {
    const parsed = parsePairingUrl(GOOD.replace("https%3A%2F%2Fbox.tailnet.ts.net", "http%3A%2F%2F100.64.0.9%3A7171"));
    expect(parsed?.endpoint).toBe("http://100.64.0.9:7171");
  });

  // A box dialled into a relay prints the relay beside its endpoint; the
  // phone prefers it, so it has to survive the parse exactly.
  test("a relay beside the endpoint is read, and trailing slashes come off it too", () => {
    const parsed = parsePairingUrl(`${GOOD}&relay=https%3A%2F%2Frelay.example.workers.dev%2F`);
    expect(parsed?.relay).toBe("https://relay.example.workers.dev");
    expect(parsed?.endpoint).toBe("https://box.tailnet.ts.net");
  });

  test("a code without a relay has no relay field at all, so the HTTP path is taken", () => {
    expect(parsePairingUrl(GOOD)).not.toHaveProperty("relay");
  });

  // Pairing over the endpoint instead would be a silent change of route the
  // person printing the code did not choose.
  test("a relay that is not an address makes the whole code invalid rather than falling back", () => {
    expect(parsePairingUrl(`${GOOD}&relay=relay.example.workers.dev`)).toBeNull();
    expect(parsePairingUrl(`${GOOD}&relay=`)).toBeNull();
  });

  // Somebody else's QR must be reported as not ours, never half-parsed into a
  // connection attempt.
  test("anything that is not a complete Shahi code is null", () => {
    expect(parsePairingUrl("https://example.com/pair#v=1&server=a&endpoint=https%3A%2F%2Fx&secret=s")).toBeNull();
    expect(parsePairingUrl("shahi://pair?v=1&server=a&endpoint=https%3A%2F%2Fx&secret=s")).toBeNull(); // query, not fragment
    expect(parsePairingUrl("shahi://pair#v=2&server=a&endpoint=https%3A%2F%2Fx&secret=s")).toBeNull();
    expect(parsePairingUrl("shahi://pair#v=1&server=a&secret=s")).toBeNull();
    expect(parsePairingUrl("shahi://pair#v=1&server=a&endpoint=box.tailnet.ts.net&secret=s")).toBeNull(); // no scheme
    expect(parsePairingUrl("shahi://pair#v=1&server=a&endpoint=https%3A%2F%2Fx&secret=")).toBeNull();
    expect(parsePairingUrl("shahi://pair#v=1&server=a&endpoint=https%3A%2F%2Fx&secret=%E0%A4%A")).toBeNull(); // bad escape
    expect(parsePairingUrl("WIFI:S:home;T:WPA;P:hunter2;;")).toBeNull();
    expect(parsePairingUrl("")).toBeNull();
  });
});
