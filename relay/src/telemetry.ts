/**
 * The relay's telemetry plane — the one place Shahi legitimately has a fleet
 * view, because the relay is your infrastructure and it already sees the
 * metadata (who is connected, how the connection ended, from where) while it
 * stays blind to a single byte of a session.
 *
 * Every event is one Workers Analytics Engine data point. Analytics Engine
 * expires data automatically, has plan-specific usage allowances, and is queried
 * with SQL for "how many boxes are online", "what is closing and why", and
 * "is one source hammering us". What is NOT recorded is as important as what
 * is: no request path, no frame body, no raw client IP (Cloudflare's own
 * analytics and WAF already hold per-IP data transiently) — only the
 * `serverId`, a stable pseudonymous key hash, and coarse signals.
 *
 * The whole module is a no-op when `TELEMETRY` is unbound, so `wrangler dev`
 * and the test harness are unaffected and a deploy without the dataset simply
 * records nothing.
 */

/**
 * The one method this module calls on the Analytics Engine binding. Declared
 * locally rather than pulled from the global `AnalyticsEngineDataset` type so
 * telemetry.ts typechecks under any project that imports it (the test project
 * does not load @cloudflare/workers-types).
 */
import { readUsage } from "./usage";

export interface Dataset {
  writeDataPoint(point: { blobs?: (string | ArrayBuffer)[]; doubles?: number[]; indexes?: (string | ArrayBuffer)[] }): void;
}

/** The bindings this module reads. All optional: absent means telemetry off. */
export interface TelemetryEnv {
  /** The Analytics Engine dataset, declared in wrangler.toml. */
  TELEMETRY?: Dataset;
  /** Bearer token the /stats endpoint requires. Unset hides the endpoint entirely. */
  STATS_TOKEN?: string;
  /** For /stats to query Analytics Engine: the account id and an API token with Account Analytics Read. */
  CF_ACCOUNT_ID?: string;
  CF_ANALYTICS_TOKEN?: string;
}

/** One telemetry event. `serverId` is a key hash, never an identity. */
export interface Event {
  /** box_auth, box_gone, phone_open, phone_close, refused, connect, rate_limited. */
  kind: string;
  serverId: string;
  /** A close reason, a refusal cause, or a role — never content. */
  detail?: string;
  /** A close code, a live phone count, or 1. */
  value?: number;
  /** Cloudflare colo the request landed in, for a by-region view. */
  colo?: string;
  upBytes?: number;
  downBytes?: number;
  upFrames?: number;
  downFrames?: number;
  durationMs?: number;
  synthetic?: boolean;
}

/**
 * Records one event. Fire-and-forget: a data point is buffered by the runtime,
 * so this never blocks the socket path and never throws into it.
 *
 * Schema (Analytics Engine columns): blob1 kind, blob2 serverId, blob3 detail,
 * blob4 colo, blob5 synthetic-probe marker; double1 value, double2/3 bytes up/down, double4/5 frames up/down,
 * double6 durationMs; index1 kind (the sampling key, kept low-cardinality
 * so counts stay even under Analytics Engine's adaptive sampling).
 */
export function record(env: TelemetryEnv, e: Event): void {
  const allowed = new Set(["box_auth", "box_gone", "box_presence", "phone_open", "phone_close", "refused", "connect", "rate_limited", "traffic", "auth_failed", "internal_error"]);
  if (!allowed.has(e.kind)) return;
  const detail = new Set(["box", "phone", "rate", "frame too large", "control too large", "too many phones", "too many pending boxes", "box offline", "closed by box", "gone", "replaced", "idle", "no hello", "silent", "auth timeout", "unauthorized", "send failed", "socket handler", "control send"]).has(e.detail ?? "") ? e.detail! : "";
  const numbers = [e.value ?? 1, e.upBytes ?? 0, e.downBytes ?? 0, e.upFrames ?? 0, e.downFrames ?? 0, e.durationMs ?? 0].map((n) => Number.isFinite(n) ? Math.max(0, n) : 0);
  const serverId = /^[A-Za-z0-9_-]{43}$/.test(e.serverId) ? e.serverId : "";
  const colo = /^[A-Z]{3}$/.test(e.colo ?? "") ? e.colo! : "";
  // Invocation logs are disabled. Never log incoming URLs, headers, frames or exception text.
  // Traffic is aggregated in socket attachments and emitted at alarm/close, never per frame.
  if (env.TELEMETRY) {
    try { console.log({ service: "shahi-relay", event: e.kind, serverId, detail, colo, synthetic: e.synthetic === true, value: numbers[0],
      upBytes: numbers[1], downBytes: numbers[2], upFrames: numbers[3], downFrames: numbers[4], durationMs: numbers[5] }); } catch {}
  }
  if (!env.TELEMETRY) return;
  try {
    env.TELEMETRY.writeDataPoint({
      blobs: [e.kind, serverId, detail, colo, e.synthetic ? "probe" : ""],
      doubles: numbers,
      indexes: [e.kind],
    });
  } catch {
    // Telemetry must never break the relay; a dropped data point is fine.
  }
}

/** The dataset name; kept here so the queries and the binding agree. */
export const DATASET = "shahi_relay";

// Only constant SQL fragments reach the query; request text is never interpolated.
const statsPeriods: Record<string, { interval: string; bucket: string; seconds: number; bucketSeconds: number; label: string }> = Object.assign(Object.create(null), {
  "1h": { interval: "INTERVAL '1' HOUR", bucket: "INTERVAL '5' MINUTE", seconds: 3600, bucketSeconds: 300, label: "last 1 hour" },
  "24h": { interval: "INTERVAL '24' HOUR", bucket: "INTERVAL '1' HOUR", seconds: 86400, bucketSeconds: 3600, label: "last 24 hours" },
  "7d": { interval: "INTERVAL '7' DAY", bucket: "INTERVAL '6' HOUR", seconds: 604800, bucketSeconds: 21600, label: "last 7 days" },
});

/**
 * Answers `GET /stats` with a live summary, or the right refusal:
 *   - no STATS_TOKEN set    -> null (the caller 404s; the endpoint is hidden)
 *   - wrong/absent bearer   -> 401
 *   - no CF query creds set  -> 503 (writing works, reading is not configured)
 * Otherwise it runs a handful of Analytics Engine queries and returns JSON.
 */
export async function handleStats(request: Request, env: TelemetryEnv): Promise<Response | null> {
  if (!env.STATS_TOKEN) return null; // endpoint disabled -> let the caller 404
  const bearer = request.headers.get("authorization");
  if (bearer !== `Bearer ${env.STATS_TOKEN}`) {
    return json({ error: "unauthorized" }, 401);
  }
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
  const range = new URL(request.url).searchParams.get("window") ?? "1h";
  const period = statsPeriods[range];
  if (!period) return json({ error: "window must be 1h, 24h or 7d" }, 400);
  if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) {
    return json(
      { error: "stats reads are not configured; set CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN (Account Analytics Read) as secrets" },
      503,
    );
  }
  try {
    if (new URL(request.url).searchParams.get("view") === "usage") return json(await readUsage(env));
    const [boxesOnline, byKind, closeCodes, refusals, byColo, traffic, handshake, timeline, alerts, site, signupWindow, capacity, outcomes, durations] = await Promise.all([
      // Presence includes long-lived connections, with a ten-minute aging window.
      one(env, `SELECT COUNT(DISTINCT blob2) AS n FROM ${DATASET} WHERE blob5 != 'probe' AND blob1 IN ('box_auth', 'box_presence') AND timestamp > NOW() - INTERVAL '10' MINUTE`),
      rows(env, `SELECT blob1 AS kind, SUM(_sample_interval) AS n FROM ${DATASET} WHERE blob5 != 'probe' AND timestamp > NOW() - ${period.interval} GROUP BY kind ORDER BY n DESC`),
      rows(env, `SELECT double1 AS code, SUM(_sample_interval) AS n FROM ${DATASET} WHERE blob5 != 'probe' AND blob1='phone_close' AND timestamp > NOW() - ${period.interval} GROUP BY code ORDER BY n DESC`),
      rows(env, `SELECT blob3 AS reason, SUM(_sample_interval) AS n FROM ${DATASET} WHERE blob5 != 'probe' AND blob1='refused' AND timestamp > NOW() - ${period.interval} GROUP BY reason ORDER BY n DESC`),
      rows(env, `SELECT blob4 AS colo, SUM(_sample_interval) AS n FROM ${DATASET} WHERE blob5 != 'probe' AND blob1='connect' AND timestamp > NOW() - ${period.interval} GROUP BY colo ORDER BY n DESC LIMIT 20`),
      rows(env, `SELECT SUM(double2 * _sample_interval) AS upBytes, SUM(double3 * _sample_interval) AS downBytes, SUM(double4 * _sample_interval) AS upFrames, SUM(double5 * _sample_interval) AS downFrames FROM ${DATASET} WHERE blob5 != 'probe' AND blob1='traffic' AND timestamp > NOW() - ${period.interval}`),
      rows(env, `SELECT SUM(_sample_interval) AS n, SUM(double6 * _sample_interval) / SUM(_sample_interval) AS meanMs, MAX(double6) AS maxMs, quantileExactWeighted(0.50)(double6, _sample_interval) AS p50Ms, quantileExactWeighted(0.95)(double6, _sample_interval) AS p95Ms, quantileExactWeighted(0.99)(double6, _sample_interval) AS p99Ms FROM ${DATASET} WHERE blob5 != 'probe' AND blob1='box_auth' AND timestamp > NOW() - ${period.interval}`),
      rows(env, `SELECT toStartOfInterval(timestamp, ${period.bucket}) AS at, blob1 AS kind, SUM(_sample_interval) AS n FROM ${DATASET} WHERE blob5 != 'probe' AND timestamp > NOW() - ${period.interval} GROUP BY at, kind ORDER BY at`),
      alertMetrics(env),
      rows(env, `SELECT double1 AS status, SUM(_sample_interval) AS n, SUM(double2 * _sample_interval) / SUM(_sample_interval) AS meanMs FROM shahi_site WHERE timestamp > NOW() - INTERVAL '5' MINUTE GROUP BY status`),
      rows(env, `SELECT double1 AS status, SUM(_sample_interval) AS n, SUM(double2 * _sample_interval) / SUM(_sample_interval) AS meanMs FROM shahi_site WHERE timestamp > NOW() - ${period.interval} GROUP BY status`),
      // Last observation per computer per five-minute bucket, then sum. Never sum
      // each computer's maximum and call that a simultaneous fleet maximum. These
      // asynchronous, possibly sampled observations remain explicitly estimates.
      rows(env, `SELECT at, SUM(online) AS computers, SUM(phones) AS phones, MAX(maxPhones) AS busiestComputer FROM (SELECT toStartOfInterval(timestamp, INTERVAL '5' MINUTE) AS at, blob2 AS computer, argMax(if(blob1='box_gone', 0, 1), timestamp) AS online, argMax(if(blob1 IN ('phone_open', 'box_presence'), double1, 0.0), timestamp) AS phones, MAX(if(blob1 IN ('phone_open', 'box_presence'), double1, 0.0)) AS maxPhones FROM ${DATASET} WHERE blob5 != 'probe' AND blob2 != '' AND blob1 IN ('box_auth', 'box_presence', 'phone_open', 'box_gone') AND timestamp > NOW() - ${period.interval} GROUP BY at, computer) GROUP BY at ORDER BY at LIMIT 2018`),
      rows(env, `SELECT blob1 AS kind, blob3 AS reason, SUM(_sample_interval) AS n FROM ${DATASET} WHERE blob5 != 'probe' AND blob1 IN ('box_auth', 'auth_failed', 'phone_open', 'refused', 'box_gone', 'phone_close') AND timestamp > NOW() - ${period.interval} GROUP BY kind, reason`),
      rows(env, `SELECT blob1 AS kind, SUM(_sample_interval) AS n, quantileExactWeighted(0.50)(double6, _sample_interval) AS p50Ms, quantileExactWeighted(0.95)(double6, _sample_interval) AS p95Ms FROM ${DATASET} WHERE blob5 != 'probe' AND blob1 IN ('phone_close', 'box_gone') AND timestamp > NOW() - ${period.interval} GROUP BY kind`),
    ]);
    return json({
      window: `${period.label} (boxesOnline: last 10 min)`,
      range, seconds: period.seconds, bucketSeconds: period.bucketSeconds,
      boxesOnlineEstimate: boxesOnline,
      eventsByKind: byKind,
      phoneCloseCodes: closeCodes,
      refusalsByReason: refusals,
      connectsByColo: byColo,
      traffic: traffic[0] ?? {}, boxHandshake: handshake[0] ?? {}, timeline, alerts, site, signupWindow,
      capacity, outcomes, durations,
      generatedAt: new Date().toISOString(),
    });
  } catch {
    return json({ error: "analytics query failed" }, 502);
  }
}

/** Runs one SQL query against Analytics Engine and returns its rows. */
async function query(env: TelemetryEnv, sql: string): Promise<Record<string, unknown>[]> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, "content-type": "text/plain" },
    body: sql,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`analytics query ${res.status}`);
  const result = await res.json() as { data?: Record<string, unknown>[] };
  if (!Array.isArray(result.data)) throw new Error("invalid analytics response");
  return result.data;
}
async function rows(env: TelemetryEnv, sql: string): Promise<Record<string, unknown>[]> {
  return query(env, sql);
}
async function one(env: TelemetryEnv, sql: string): Promise<number> {
  const r = await query(env, sql);
  const v = r[0] ? Object.values(r[0])[0] : 0;
  return Number(v) || 0;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

/** Five-minute fleet signals; failures throw so missing analytics cannot appear healthy. */
export async function alertMetrics(env: TelemetryEnv): Promise<Record<string, number>> {
  const data = await query(env, `SELECT blob1 AS kind, SUM(_sample_interval) AS n FROM ${DATASET} WHERE blob5 != 'probe' AND timestamp > NOW() - INTERVAL '5' MINUTE GROUP BY kind`);
  return Object.fromEntries(data.filter((r) => typeof r.kind === "string").map((r) => [r.kind, Number(r.n) || 0]));
}
