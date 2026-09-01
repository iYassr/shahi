import { describe, expect, test } from "bun:test";
import { isLoopback, phoneEndpoint } from "./endpoint";

// The shape `tailscale status --json` actually prints: DNSName carries a
// trailing dot, which a browser would reject in an https:// URL.
const tailscale = JSON.stringify({ Self: { DNSName: "box.tail1234.ts.net.", HostName: "box" } });

describe("phoneEndpoint", () => {
  test("prefers the Tailscale name, as https, without the trailing dot", () => {
    expect(phoneEndpoint(tailscale, "127.0.0.1", 7171)).toBe("https://box.tail1234.ts.net");
  });

  test("falls back to a non-loopback bind address", () => {
    expect(phoneEndpoint(null, "100.100.100.100", 7171)).toBe("http://100.100.100.100:7171");
  });

  test("has nothing to say for a loopback bind without tailscale", () => {
    // Printing http://127.0.0.1 on a QR would be a code the phone cannot use;
    // an empty answer makes the caller ask instead.
    expect(phoneEndpoint(null, "127.0.0.1", 7171)).toBe("");
    expect(phoneEndpoint("not json", "localhost", 7171)).toBe("");
    expect(phoneEndpoint(JSON.stringify({ Self: {} }), "::1", 7171)).toBe("");
  });
});

describe("isLoopback", () => {
  test("knows the three spellings", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("localhost")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("0.0.0.0")).toBe(false);
  });
});
