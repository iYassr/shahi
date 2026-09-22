/**
 * The Worker's front door, off the wire: what `wrangler dev` cannot show,
 * because it sets no connect limiter and presents every request as loopback.
 */
import { describe, expect, mock, test } from "bun:test";
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

function connect(ip: string): Request {
  return new Request(`https://relay.example/v1/box/${SERVER_ID}`, {
    headers: { upgrade: "websocket", "cf-connecting-ip": ip },
  });
}

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
