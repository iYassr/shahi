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
    record(env, { kind: "phone_close", serverId: "abc123", detail: "rate", value: 4429, colo: "SIN" });
    expect(points).toHaveLength(1);
    expect(points[0]).toEqual({
      blobs: ["phone_close", "abc123", "rate", "SIN"],
      doubles: [4429],
      indexes: ["phone_close"],
    });
  });

  test("defaults value to 1 and omitted strings to empty", () => {
    const { env, points } = capturing();
    record(env, { kind: "box_auth", serverId: "id" });
    expect(points[0]).toEqual({ blobs: ["box_auth", "id", "", ""], doubles: [1], indexes: ["box_auth"] });
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
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ n: 7 }] }), { status: 200 })) as typeof fetch;
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
