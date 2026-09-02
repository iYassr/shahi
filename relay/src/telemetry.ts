/**
 * The relay's telemetry plane — the one place Shahi legitimately has a fleet
 * view, because the relay is your infrastructure and it already sees the
 * metadata (who is connected, how the connection ended, from where) while it
 * stays blind to a single byte of a session.
 *
 * Every event is one Workers Analytics Engine data point. Analytics Engine
 * charges nothing to write, keeps no row you have to prune (unlike the
 * Durable Object's storage, which the relay never touches), and is queried
 * with SQL for "how many boxes are online", "what is closing and why", and
 * "is one source hammering us". What is NOT recorded is as important as what
 * is: no request path, no frame body, no raw client IP (Cloudflare's own
 * analytics and WAF already hold per-IP data transiently) — only the
 * `serverId`, which is a hash and not an identity, and coarse signals.
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
}

/**
 * Records one event. Fire-and-forget: a data point is buffered by the runtime,
 * so this never blocks the socket path and never throws into it.
 *
 * Schema (Analytics Engine columns): blob1 kind, blob2 serverId, blob3 detail,
 * blob4 colo; double1 value; index1 kind (the sampling key, kept low-cardinality
 * so counts stay even under Analytics Engine's adaptive sampling).
 */
export function record(env: TelemetryEnv, e: Event): void {
  if (!env.TELEMETRY) return;
  try {
    env.TELEMETRY.writeDataPoint({
      blobs: [e.kind, e.serverId, e.detail ?? "", e.colo ?? ""],
      doubles: [e.value ?? 1],
      indexes: [e.kind],
    });
  } catch {
    // Telemetry must never break the relay; a dropped data point is fine.
  }
}

/** The dataset name; kept here so the queries and the binding agree. */
export const DATASET = "shahi_relay";

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
  if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) {
    return json(
      { error: "stats reads are not configured; set CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN (Account Analytics Read) as secrets" },
      503,
    );
  }
  try {
    const [boxesOnline, byKind, closeCodes, refusals, byColo] = await Promise.all([
      // Boxes seen authenticating in the last 10 minutes: a live-ish "online" estimate.
      one(env, `SELECT COUNT(DISTINCT blob2) AS n FROM ${DATASET} WHERE blob1='box_auth' AND timestamp > NOW() - INTERVAL '10' MINUTE`),
      rows(env, `SELECT blob1 AS kind, SUM(_sample_interval) AS n FROM ${DATASET} WHERE timestamp > NOW() - INTERVAL '1' HOUR GROUP BY kind ORDER BY n DESC`),
      rows(env, `SELECT double1 AS code, SUM(_sample_interval) AS n FROM ${DATASET} WHERE blob1='phone_close' AND timestamp > NOW() - INTERVAL '1' HOUR GROUP BY code ORDER BY n DESC`),
      rows(env, `SELECT blob3 AS reason, SUM(_sample_interval) AS n FROM ${DATASET} WHERE blob1='refused' AND timestamp > NOW() - INTERVAL '1' HOUR GROUP BY reason ORDER BY n DESC`),
      rows(env, `SELECT blob4 AS colo, SUM(_sample_interval) AS n FROM ${DATASET} WHERE blob1='connect' AND timestamp > NOW() - INTERVAL '1' HOUR GROUP BY colo ORDER BY n DESC LIMIT 20`),
    ]);
    return json({
      window: "last 1 hour (boxesOnline: last 10 min)",
      boxesOnlineEstimate: boxesOnline,
      eventsByKind: byKind,
      phoneCloseCodes: closeCodes,
      refusalsByReason: refusals,
      connectsByColo: byColo,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
}

/** Runs one SQL query against Analytics Engine and returns its rows. */
async function query(env: TelemetryEnv, sql: string): Promise<Record<string, unknown>[]> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, "content-type": "text/plain" },
    body: sql,
  });
  if (!res.ok) throw new Error(`analytics query ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { data?: Record<string, unknown>[] }).data ?? [];
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
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json" } });
}
