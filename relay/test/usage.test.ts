import { expect, test } from "bun:test";
import { monthlyModel, readUsage, type UsageTotals } from "../src/usage";
const zero: UsageTotals = { workerRequests: 0, workerCpuMs: 0, durableRequests: 0, durableDurationGbSeconds: 0, rowsRead: 0, rowsWritten: 0 };
test("monthly model converts a seven-day window once and shares allowances across the account", () => {
  expect(monthlyModel(zero).totalUsd).toBe(5);
  // Cloudflare's published Workers example: 15M requests at 7ms costs $8.
  const example = monthlyModel({ ...zero, workerRequests: 15e6, workerCpuMs: 105e6 }, 30);
  expect(example.totalUsd).toBe(8);
  expect(monthlyModel({ ...zero, workerRequests: 3.5e6, workerCpuMs: 24.5e6 }).totalUsd).toBe(8);
});
test("Durable Object overage rounds up billable units after its included allowance", () => {
  expect(monthlyModel({ ...zero, durableDurationGbSeconds: 400000 }, 30).costs.durableDuration).toBe(0);
  expect(monthlyModel({ ...zero, durableDurationGbSeconds: 400001 }, 30).costs.durableDuration).toBe(12.5);
  expect(monthlyModel({ ...zero, durableDurationGbSeconds: 1400001 }, 30).costs.durableDuration).toBe(25);
  expect(monthlyModel({ ...zero, durableRequests: 1000001, rowsWritten: 50000001 }, 30).totalUsd).toBe(6.15);
  expect(() => monthlyModel({ ...zero, workerRequests: NaN })).toThrow();
  expect(() => monthlyModel(zero, 0)).toThrow();
});
const worker = (name: string, requests: number) => ({ dimensions: { scriptName: name }, sum: { requests, cpuTimeUs: 2000, errors: 0 } });
const invocation = (name: string, ns: string, type: string, requests: number) => ({ dimensions: { scriptName: name, namespaceId: ns, type }, sum: { requests, errors: 0 } });
const periodic = (ns: string) => ({ dimensions: { namespaceId: ns }, sum: { duration: 100, rowsRead: 2, rowsWritten: 3, inboundWebsocketMsgCount: 100 } });
const account = () => ({ workers: [worker('shahi-relay', 100), worker('unrelated-private-project', 200)],
  invocations: [invocation('shahi-relay', 'shahi-ns', 'hibernation', 100), invocation('unrelated-private-project', 'other-ns', 'http', 200)],
  periodic: [periodic('shahi-ns'), periodic('other-ns')] });
const env = { CF_ACCOUNT_ID: 'account', CF_ANALYTICS_TOKEN: 'secret' };
test("live usage separates Shahi from the account, converts microseconds, and keeps unrelated names private", async () => {
  const original = globalThis.fetch;
  let sent: any;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => { sent = JSON.parse(init!.body as string); return Response.json({ data: { viewer: { accounts: [account()] } }, errors: null }); }) as unknown as typeof fetch;
  try {
    const result = await readUsage(env, Date.parse('2026-09-28T07:37:00Z'));
    expect(result.since).toBe('2026-09-21T07:30:00.000Z'); expect(result.until).toBe('2026-09-28T07:30:00.000Z');
    expect(result.account.workerRequests).toBe(300); expect(result.shahi.workerRequests).toBe(100);
    expect(result.account.workerCpuMs).toBe(4); expect(result.shahi.workerCpuMs).toBe(2);
    expect(result.shahi.durableRequests).toBe(105); expect(result.account.durableRequests).toBe(310);
    expect(result.shahi.durableDurationGbSeconds).toBe(100);
    expect(JSON.stringify(result)).not.toContain('unrelated-private-project'); expect(JSON.stringify(result)).not.toContain('secret');
    expect(sent.variables.account).toBe('account');
  } finally { globalThis.fetch = original; }
});
test("GraphQL partial errors, truncated rows, and absent or invalid metrics fail rather than showing zero cost", async () => {
  const original = globalThis.fetch;
  const missing = account(); delete (missing.workers[0]!.sum as any).cpuTimeUs;
  const negative = account(); negative.periodic[0]!.sum.duration = -1;
  const truncated = account(); truncated.workers = Array.from({ length: 1000 }, () => worker('shahi-relay', 1));
  try {
    for (const body of [{ errors: [{ message: 'private detail' }], data: { viewer: { accounts: [account()] } } },
      { data: { viewer: { accounts: [] } } }, ...[missing, negative, truncated, {}].map(a => ({ data: { viewer: { accounts: [a] } } }))]) {
      globalThis.fetch = (async () => Response.json(body)) as unknown as typeof fetch;
      await expect(readUsage(env)).rejects.toThrow();
    }
    globalThis.fetch = (async () => Response.json({}, { status: 403 })) as unknown as typeof fetch;
    await expect(readUsage(env)).rejects.toThrow('usage unavailable');
  } finally { globalThis.fetch = original; }
});
