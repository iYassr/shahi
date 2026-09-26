/**
 * The Worker's front door, off the wire: what `wrangler dev` cannot show,
 * because it sets no connect limiter and serves plain HTTP to loopback.
 */
import { describe, expect, mock, test } from "bun:test";
import { STRICT_TRANSPORT_SECURITY } from "../src/hsts";
import { connectLimitKey } from "../src/limits";

mock.module("cloudflare:workers", () => ({ DurableObject: class { constructor(readonly ctx: unknown) {} } }));
const worker = (await import(new URL("../src/index.ts", import.meta.url).href)).default as {
  fetch(request: Request, env: unknown): Promise<Response>;
};

const SERVER_ID = "A".repeat(43);

/** The production limiter's shape: thirty per key, and every key it was asked about. */
function environment() {
  const counts = new Map<string, number>();
  const env = {
    CONNECT_LIMIT: {
      async limit({ key }: { key: string }) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return { success: counts.get(key)! <= 30 };
      },
    },
    RELAY: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => new Response("routed") }),
    },
  };
  return { env, counts };
}

describe("strict transport security", () => {
  test("every HTTPS response from the front door tells browsers to stay on HTTPS", async () => {
    // The relay sent no HSTS header at all (pre-release review 2026-09-22, P02-X1).
    const { env } = environment();
    const failing = { ...env, RELAY: { idFromName: (name: string) => name, get: () => ({ fetch: async () => { throw new Error("down"); } }) } };
    const cases: [string, RequestInit, unknown, number][] = [
      ["/health", {}, env, 200],
      ["/", {}, env, 404],
      ["/stats", {}, env, 404],
      ["/v1/box/short", {}, env, 400],
      [`/v1/box/${SERVER_ID}`, {}, env, 426],
      [`/v1/box/${SERVER_ID}`, { headers: { upgrade: "websocket" } }, failing, 503],
    ];
    for (const [path, init, bindings, status] of cases) {
      const response = await worker.fetch(new Request(`https://relay.example${path}`, init), bindings);
      expect(response.status, path).toBe(status);
      expect(response.headers.get("strict-transport-security"), path).toBe(STRICT_TRANSPORT_SECURITY);
    }
    for (let i = 0; i < 30; i++) await worker.fetch(connect("192.0.2.9"), env);
    const limited = await worker.fetch(connect("192.0.2.9"), env);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("strict-transport-security")).toBe(STRICT_TRANSPORT_SECURITY);
  });

  test("a response over plain HTTP on this machine carries none, and is served", async () => {
    // What `wrangler dev` hands the Worker: its route's host over http, from a
    // loopback address (measured, wrangler 4.129). The tests send no address.
    const local = [
      new Request("http://127.0.0.1:8787/health"),
      new Request("http://relay.example/health", { headers: { "cf-connecting-ip": "127.0.0.1" } }),
      new Request("http://relay.example/health", { headers: { "cf-connecting-ip": "::1" } }),
    ];
    for (const request of local) {
      const response = await worker.fetch(request, environment().env);
      expect(response.status, request.url).toBe(200);
      expect(response.headers.get("strict-transport-security"), request.url).toBeNull();
    }
  });

  test("plain HTTP from the edge is sent to HTTPS, and a cleartext upgrade is never routed", async () => {
    // relay.getshahi.dev answered /health over HTTP and upgraded ws:// to a
    // live link, because the zone's "Always Use HTTPS" was off and nothing
    // here checked the scheme (pre-release bug hunt, B51).
    let routed = 0;
    const env = { RELAY: { idFromName: (name: string) => name, get: () => ({ fetch: async () => { routed++; return new Response("routed"); } }) } };
    const edge = { "cf-connecting-ip": "192.0.2.9" };
    const health = await worker.fetch(new Request("http://relay.example/health?probe=1", { headers: edge }), env);
    expect(health.status).toBe(301);
    expect(health.headers.get("location")).toBe("https://relay.example/health?probe=1");
    expect(health.headers.get("strict-transport-security")).toBeNull();
    const upgrade = await worker.fetch(new Request(`http://relay.example/v1/phone/${SERVER_ID}`, { headers: { ...edge, upgrade: "websocket" } }), env);
    expect(upgrade.status).toBe(301);
    expect(upgrade.headers.get("location")).toBe(`https://relay.example/v1/phone/${SERVER_ID}`);
    expect(routed).toBe(0);
    // Over HTTPS the same visitor is routed.
    expect((await worker.fetch(new Request(`https://relay.example/v1/phone/${SERVER_ID}`, { headers: { ...edge, upgrade: "websocket" } }), env)).status).toBe(200);
    expect(routed).toBe(1);
  });

  test("the object's upgrade is passed through untouched", async () => {
    // Re-wrapping it would put its WebSocket at risk; the object sets the header itself.
    const upgrade = new Response(null, { status: 101 });
    const env = { RELAY: { idFromName: (name: string) => name, get: () => ({ fetch: async () => upgrade }) } };
    expect(await worker.fetch(new Request(`https://relay.example/v1/phone/${SERVER_ID}`, { headers: { upgrade: "websocket" } }), env)).toBe(upgrade);
  });
});

function connect(ip: string): Request {
  return new Request(`https://relay.example/v1/box/${SERVER_ID}`, {
    headers: { upgrade: "websocket", "cf-connecting-ip": ip },
  });
}

describe("the health check", () => {
  test("answers HEAD as it answers GET, so a monitor that uses HEAD sees the relay up", async () => {
    // Only GET matched, so HEAD /health fell through to the 404 (pre-release bug hunt, B106).
    const { env } = environment();
    for (const method of ["GET", "HEAD"]) {
      const response = await worker.fetch(new Request("https://relay.example/health", { method }), env);
      expect(response.status, method).toBe(200);
      expect(response.headers.get("cache-control"), method).toBe("no-store");
      expect(response.headers.get("strict-transport-security"), method).toBe(STRICT_TRANSPORT_SECURITY);
    }
  });

  test("any other method is told which ones it may use", async () => {
    const { env } = environment();
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
      const response = await worker.fetch(new Request("https://relay.example/health", { method }), env);
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow"), method).toBe("GET, HEAD");
    }
  });
});

describe("the connect limiter", () => {
  test("one IPv6 host cannot get past it by using a fresh address from its /64", async () => {
    // Every /128 had a bucket of its own, so a host with a routed /64 was never
    // limited at all (pre-release review 2026-09-22, F80).
    const { env } = environment();
    const statuses: number[] = [];
    for (let i = 1; i <= 31; i++) statuses.push((await worker.fetch(connect(`2001:db8:1:2::${i.toString(16)}`), env)).status);
    expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  test("another /64 and an IPv4 address keep buckets of their own", async () => {
    const { env } = environment();
    for (let i = 1; i <= 30; i++) await worker.fetch(connect(`2001:db8:1:2::${i.toString(16)}`), env);
    expect((await worker.fetch(connect("2001:db8:1:3::1"), env)).status).toBe(200);
    expect((await worker.fetch(connect("192.0.2.1"), env)).status).toBe(200);
  });

  test("an IPv6 address is keyed by its /64 however it is written", () => {
    const key = "2001:db8:1:2::/64";
    expect(connectLimitKey("2001:db8:1:2::1")).toBe(key);
    expect(connectLimitKey("2001:0DB8:0001:0002:ffff:ffff:ffff:ffff")).toBe(key);
    expect(connectLimitKey("2001:db8:1:2:0:0:0:0")).toBe(key);
    expect(connectLimitKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(connectLimitKey("::1:2:3:4:5")).toBe("0:0:0:1::/64");
    expect(connectLimitKey("2001:db8:1:3::1")).not.toBe(key);
  });

  test("an IPv4 address, or anything that is not plain IPv6, is one address", () => {
    expect(connectLimitKey("192.0.2.1")).toBe("192.0.2.1");
    expect(connectLimitKey("::ffff:192.0.2.1")).toBe("::ffff:192.0.2.1");
    expect(connectLimitKey("2001:db8::1::2")).toBe("2001:db8::1::2");
    expect(connectLimitKey("2001:db8:1:2:3")).toBe("2001:db8:1:2:3");
    expect(connectLimitKey("2001:db8:zz::1")).toBe("2001:db8:zz::1");
  });
});
