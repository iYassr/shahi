/**
 * The telemetry module, unit-tested off the wire (the socket suite runs it
 * against a real wrangler dev where writeDataPoint is a no-op, so the schema
 * and the /stats gate are proven here instead).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { handleStats, record, type TelemetryEnv } from "../src/telemetry.ts";

type Point = { blobs?: (string | ArrayBuffer)[]; doubles?: number[]; indexes?: (string | ArrayBuffer)[] };

function capturing(): { env: TelemetryEnv; points: Point[] } {
  const points: Point[] = [];
  return { points, env: { TELEMETRY: { writeDataPoint: (p: Point) => points.push(p) } } as unknown as TelemetryEnv };
}

describe("record", () => {
  test("writes one data point with kind, serverId, detail, colo, value and the sampling index", () => {
    const { env, points } = capturing();
    record(env, { kind: "phone_close", serverId: "a".repeat(43), detail: "rate", value: 4429, colo: "SIN" });
    expect(points).toHaveLength(1);
    expect(points[0]).toEqual({
      blobs: ["phone_close", "a".repeat(43), "rate", "SIN", ""],
      doubles: [4429, 0, 0, 0, 0, 0],
      indexes: ["phone_close"],
    });
  });

  test("defaults value to 1 and omitted strings to empty", () => {
    const { env, points } = capturing();
    record(env, { kind: "box_auth", serverId: "id" });
    expect(points[0]).toEqual({ blobs: ["box_auth", "", "", "", ""], doubles: [1, 0, 0, 0, 0, 0], indexes: ["box_auth"] });
  });

  test("a pending-box refusal is recorded with its reason, not an empty one", () => {
    // It was missing from the allowlist, so the lockout it signals was
    // invisible in /stats (pre-release review 2026-09-22, F28).
    const { env, points } = capturing();
    record(env, { kind: "refused", serverId: "a".repeat(43), detail: "too many pending boxes", value: 4429 });
    expect(points[0]!.blobs![2]).toBe("too many pending boxes");
  });

  test("is a no-op when telemetry is unbound", () => {
    expect(() => record({}, { kind: "connect", serverId: "id" })).not.toThrow();
  });

  test("a throwing dataset never breaks the caller", () => {
    const env = { TELEMETRY: { writeDataPoint: () => { throw new Error("boom"); } } } as unknown as TelemetryEnv;
    expect(() => record(env, { kind: "connect", serverId: "id" })).not.toThrow();
  });
});

describe("handleStats", () => {
  const get = (headers: Record<string, string> = {}) => new Request("https://relay/stats", { headers });

  test("is hidden (null) when no STATS_TOKEN is set, so the caller 404s", async () => {
    expect(await handleStats(get(), {})).toBeNull();
  });

  test("401 without the right bearer", async () => {
    const env: TelemetryEnv = { STATS_TOKEN: "s3cret" };
    expect((await handleStats(get(), env))!.status).toBe(401);
    expect((await handleStats(get({ authorization: "Bearer wrong" }), env))!.status).toBe(401);
  });

  test("503 when authed but the query credentials are not configured", async () => {
    const env: TelemetryEnv = { STATS_TOKEN: "s3cret" };
    const res = (await handleStats(get({ authorization: "Bearer s3cret" }), env))!;
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain("CF_ACCOUNT_ID");
  });

  test("200 with a shaped summary when fully configured", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ n: 7 }] }), { status: 200 })) as unknown as typeof fetch;
    try {
      const env: TelemetryEnv = { STATS_TOKEN: "s3cret", CF_ACCOUNT_ID: "acc", CF_ANALYTICS_TOKEN: "tok" };
      const res = (await handleStats(get({ authorization: "Bearer s3cret" }), env))!;
      expect(res.status).toBe(200);
      const body = (await res.json()) as { boxesOnlineEstimate: number; eventsByKind: unknown[] };
      expect(body.boxesOnlineEstimate).toBe(7);
      expect(Array.isArray(body.eventsByKind)).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  afterEach(() => {});
});

describe('dashboard time windows', () => {
  const env: TelemetryEnv = { STATS_TOKEN: 'secret', CF_ACCOUNT_ID: 'account', CF_ANALYTICS_TOKEN: 'analytics' };
  test('only allowlisted windows reach SQL, while presence and alerts keep their own windows', async () => {
    const real = globalThis.fetch; const queries: string[] = [];
    globalThis.fetch = (async (_url: unknown, options: RequestInit) => { queries.push(String(options.body)); return Response.json({ data: [] }); }) as unknown as typeof fetch;
    try {
      for (const [range, interval, bucket] of [['1h', "INTERVAL '1' HOUR", 300], ['24h', "INTERVAL '24' HOUR", 3600], ['7d', "INTERVAL '7' DAY", 21600]] as const) {
        queries.length = 0;
        const r = (await handleStats(new Request(`https://relay/stats?window=${range}`, { headers: { authorization: 'Bearer secret' } }), env))!;
        const body = await r.json() as { range: string; bucketSeconds: number };
        expect(r.status).toBe(200); expect(body.range).toBe(range); expect(body.bucketSeconds).toBe(bucket);
        expect(queries.filter(q => q.includes(interval)).length).toBeGreaterThanOrEqual(8);
        expect(queries.some(q => q.includes("INTERVAL '10' MINUTE"))).toBe(true);
        expect(queries.filter(q => q.includes("INTERVAL '5' MINUTE")).length).toBeGreaterThanOrEqual(2);
        expect(queries.filter(q => q.includes('FROM shahi_relay')).every(q => q.includes("blob5 != 'probe'"))).toBe(true);
      }
      queries.length = 0;
      for (const range of ['__proto__', 'constructor', "1h' OR 1=1", '30d']) {
        const r = await handleStats(new Request(`https://relay/stats?window=${encodeURIComponent(range)}`, { headers: { authorization: 'Bearer secret' } }), env);
        expect(r!.status).toBe(400);
      }
      expect(queries).toHaveLength(0);
    } finally { globalThis.fetch = real; }
  });
  test('query failure cannot become an empty successful dashboard', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ error: 'private upstream detail' }, { status: 500 })) as unknown as typeof fetch;
    try {
      const r = (await handleStats(new Request('https://relay/stats', { headers: { authorization: 'Bearer secret' } }), env))!;
      expect(r.status).toBe(502); expect(await r.text()).not.toContain('private');
    } finally { globalThis.fetch = real; }
  });
});
