import type { TelemetryEnv } from "./telemetry";

const SCRIPTS = ["shahi-relay", "shahi-site", "shahi-operations", "shahi-dashboard", "shahi-review-demo"];
const LIMIT = 1000;
// Verified against the account schema and published Standard rates on 2026-09-28.
// GraphQL invocation counts are operational, not invoice line items. In particular,
// hibernation events include more than billable WebSocket messages.
const QUERY = `query($account: string, $since: Time, $until: Time) {
  viewer { accounts(filter: {accountTag: $account}) {
    workers: workersInvocationsAdaptive(limit: 1000, filter: {datetime_geq: $since, datetime_lt: $until}) {
      dimensions { scriptName } sum { requests cpuTimeUs errors }
    }
    periodic: durableObjectsPeriodicGroups(limit: 1000, filter: {datetime_geq: $since, datetime_lt: $until}) {
      dimensions { namespaceId } sum { duration rowsRead rowsWritten inboundWebsocketMsgCount }
    }
    invocations: durableObjectsInvocationsAdaptiveGroups(limit: 1000, filter: {datetime_geq: $since, datetime_lt: $until}) {
      dimensions { namespaceId scriptName type } sum { requests errors }
    }
  } }
}`;
// Asked separately so that a token without access to container analytics
// loses only this line of the model, shown as unavailable, never as $0.
const CONTAINERS = `query($account: string, $since: Time, $until: Time) {
  viewer { accounts(filter: {accountTag: $account}) {
    containers: containersUsageAdaptiveGroups(limit: 1000, filter: {datetime_geq: $since, datetime_lt: $until}) {
      dimensions { applicationId } sum { allocatedMemory allocatedDisk cpuTimeSec }
    }
  } }
}`;
type Row = { dimensions: Record<string, string>; sum: Record<string, number> };
export interface UsageTotals { workerRequests: number; workerCpuMs: number; durableRequests: number; durableDurationGbSeconds: number; rowsRead: number; rowsWritten: number }
/** Account-wide only: GraphQL names a container by application, not by Worker. */
export interface ContainerTotals { memoryGibSeconds: number; diskGbSeconds: number; cpuSeconds: number }
const empty = (): UsageTotals => ({ workerRequests: 0, workerCpuMs: 0, durableRequests: 0, durableDurationGbSeconds: 0, rowsRead: 0, rowsWritten: 0 });
function value(row: Row, key: string): number {
  const n = row.sum?.[key];
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new Error("invalid usage metric");
  return n;
}
function dataset(data: unknown): Row[] {
  if (!Array.isArray(data) || data.length >= LIMIT) throw new Error("missing or truncated usage");
  for (const row of data) if (!row || typeof row.dimensions !== "object" || !row.dimensions || !row.sum) throw new Error("invalid usage row");
  return data;
}
function totals(workers: Row[], periodic: Row[], invocations: Row[]): UsageTotals {
  const result = empty();
  for (const r of workers) { result.workerRequests += value(r, "requests"); result.workerCpuMs += value(r, "cpuTimeUs") / 1000; }
  // Count all invocation events at full request weight for a conservative planning
  // model. Do not mistakenly apply 20:1 to HTTP, alarms, RPC or close/error events.
  for (const r of invocations) result.durableRequests += value(r, "requests");
  for (const r of periodic) {
    result.durableRequests += value(r, "inboundWebsocketMsgCount") / 20;
    result.durableDurationGbSeconds += value(r, "duration");
    result.rowsRead += value(r, "rowsRead"); result.rowsWritten += value(r, "rowsWritten");
  }
  return result;
}

/** A 30-day planning scenario, not a month-to-date bill or a spending ceiling. */
export function monthlyModel(totals: UsageTotals, observedDays = 7, containers: ContainerTotals | null = null) {
  if (!Number.isFinite(observedDays) || observedDays <= 0) throw new Error("invalid observation window");
  if ([...Object.values(totals), ...Object.values(containers ?? {})].some(n => !Number.isFinite(n) || n < 0)) throw new Error("invalid usage");
  const scale = (n: number) => n * 30 / observedDays;
  const projected = Object.fromEntries(Object.entries(totals).map(([key, n]) => [key, scale(n)])) as unknown as UsageTotals;
  const excess = (n: number, included: number) => Math.max(0, n - included);
  const costs: Record<string, number> = {
    subscription: 5,
    workerRequests: excess(projected.workerRequests, 10_000_000) / 1_000_000 * 0.30,
    workerCpu: excess(projected.workerCpuMs, 30_000_000) / 1_000_000 * 0.02,
    durableRequests: Math.ceil(excess(projected.durableRequests, 1_000_000) / 1_000_000) * 0.15,
    durableDuration: Math.ceil(excess(projected.durableDurationGbSeconds, 400_000) / 1_000_000) * 12.50,
    rowsRead: Math.ceil(excess(projected.rowsRead, 25_000_000_000) / 1_000_000) * 0.001,
    rowsWritten: Math.ceil(excess(projected.rowsWritten, 50_000_000) / 1_000_000),
  };
  // A container is billed for what it is allocated while it runs, not for what
  // it uses, so one that never sleeps costs the same idle as busy. The review
  // container was 85% of September 2026's usage charges while this model left
  // containers out entirely.
  if (containers) {
    costs.containerMemory = excess(scale(containers.memoryGibSeconds), 25 * 3600) * 0.0000025;
    costs.containerCpu = excess(scale(containers.cpuSeconds), 375 * 60) * 0.00002;
    costs.containerDisk = excess(scale(containers.diskGbSeconds), 200 * 3600) * 0.00000007;
  }
  return { projected, costs, containers: containers ? "included" : "unavailable", totalUsd: Object.values(costs).reduce((a, b) => a + b, 0) };
}

async function graphql(env: TelemetryEnv, query: string, since: string, until: string): Promise<Record<string, unknown>> {
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST", headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { account: env.CF_ACCOUNT_ID, since, until } }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error("usage unavailable");
  const body = await response.json() as { errors?: unknown[]; data?: { viewer?: { accounts?: Record<string, unknown>[] } } };
  if (body.errors?.length || body.data?.viewer?.accounts?.length !== 1) throw new Error("usage unavailable");
  return body.data.viewer.accounts[0]!;
}

async function readContainers(env: TelemetryEnv, since: string, until: string): Promise<ContainerTotals | null> {
  try {
    const result = { memoryGibSeconds: 0, diskGbSeconds: 0, cpuSeconds: 0 };
    // Memory is allocated GiB (2^30) and disk decimal GB, the invoice's units;
    // checked against September 2026's bill for the review container.
    for (const r of dataset((await graphql(env, CONTAINERS, since, until)).containers)) {
      result.memoryGibSeconds += value(r, "allocatedMemory") / 2 ** 30;
      result.diskGbSeconds += value(r, "allocatedDisk") / 1e9;
      result.cpuSeconds += value(r, "cpuTimeSec");
    }
    return result;
  } catch { return null; }
}

export async function readUsage(env: TelemetryEnv, now = Date.now()) {
  const until = new Date(Math.floor(now / 900_000) * 900_000).toISOString();
  const since = new Date(Date.parse(until) - 7 * 86400_000).toISOString();
  const [account, containers] = await Promise.all([graphql(env, QUERY, since, until), readContainers(env, since, until)]);
  const workers = dataset(account.workers), periodic = dataset(account.periodic), invocations = dataset(account.invocations);
  for (const r of workers) if (typeof r.dimensions.scriptName !== "string") throw new Error("missing script identity");
  for (const r of periodic) if (typeof r.dimensions.namespaceId !== "string") throw new Error("missing namespace identity");
  for (const r of invocations) if (typeof r.dimensions.namespaceId !== "string" || typeof r.dimensions.scriptName !== "string") throw new Error("missing invocation identity");
  const shahiWorkers = workers.filter(r => SCRIPTS.includes(r.dimensions.scriptName!));
  const shahiInvocations = invocations.filter(r => SCRIPTS.includes(r.dimensions.scriptName!));
  const namespaces = new Set(shahiInvocations.map(r => r.dimensions.namespaceId));
  const shahiPeriodic = periodic.filter(r => namespaces.has(r.dimensions.namespaceId));
  const all = totals(workers, periodic, invocations);
  // Return only Shahi names; other applications contribute aggregate account usage
  // because included allowances are shared, not a fresh allowance per Worker.
  return { since, until, generatedAt: new Date(now).toISOString(), account: all, containers,
    shahi: totals(shahiWorkers, shahiPeriodic, shahiInvocations), model: monthlyModel(all, 7, containers),
    workers: shahiWorkers.map(r => ({ name: r.dimensions.scriptName, requests: value(r, "requests"), cpuMs: value(r, "cpuTimeUs") / 1000, errors: value(r, "errors") })),
    pricingCheckedAt: "2026-10-01", scope: "account", days: 7,
  };
}

/**
 * Per-object alarm and message counts are the one signal of a runaway relay
 * bug that does not depend on the relay's own code being right. Healthy
 * objects measured 3–29 September 2026 peaked at 26 alarms and 22,828 socket
 * messages in an hour; the September alarm storm ran about 45,000 alarms an
 * hour on each of eight objects. Only the busiest object's count is returned,
 * never its id.
 */
const HOTSPOTS = `query($account: string, $since: Time, $until: Time) {
  viewer { accounts(filter: {accountTag: $account}) {
    alarms: durableObjectsInvocationsAdaptiveGroups(limit: 1, orderBy: [sum_requests_DESC], filter: {datetime_geq: $since, datetime_lt: $until, scriptName: "shahi-relay", type: "alarm"}) {
      dimensions { objectId } sum { requests }
    }
    messages: durableObjectsInvocationsAdaptiveGroups(limit: 1, orderBy: [sum_requests_DESC], filter: {datetime_geq: $since, datetime_lt: $until, scriptName: "shahi-relay", type: "hibernation"}) {
      dimensions { objectId } sum { requests }
    }
  } }
}`;

export async function readHotspots(env: TelemetryEnv, now = Date.now()) {
  // The last hour, ending at the preceding five minutes, which analytics has had time to settle.
  const until = new Date(Math.floor(now / 300_000) * 300_000).toISOString();
  const since = new Date(Date.parse(until) - 3_600_000).toISOString();
  const account = await graphql(env, HOTSPOTS, since, until);
  const busiest = (data: unknown) => {
    const rows = dataset(data);
    return rows.length ? value(rows[0]!, "requests") : 0;
  };
  return { since, until, generatedAt: new Date(now).toISOString(), maxAlarmsPerObject: busiest(account.alarms), maxMessagesPerObject: busiest(account.messages) };
}
