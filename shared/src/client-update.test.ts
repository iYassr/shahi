import { expect, test, mock } from "bun:test";
import { ClientUpdateCheck, CLIENT_UPDATE_URL, parseUpdatePolicy, requiredUpdate, type ClientUpdatePolicy, type UpdateRule } from "./client-update";

const NOW = Date.parse("2026-09-29T00:00:00Z");
const rule: UpdateRule = { minimumBuild: 28, expiresAt: "2026-09-30T00:00:00Z", message: "This update fixes conversation loading." };
const policy: ClientUpdatePolicy = { schema: 1, ios: rule, web: null };

test("only an older known build on the named platform is required to update", () => {
  expect(requiredUpdate(policy, "ios", 27, NOW)).toEqual(rule);
  for (const build of [28, 29, 0, NaN, 27.5]) expect(requiredUpdate(policy, "ios", build, NOW)).toBeNull();
  expect(requiredUpdate(policy, "web", 1, NOW)).toBeNull();
  expect(requiredUpdate(policy, "ios", 27, Date.parse(rule.expiresAt))).toBeNull();
});

test("malformed and unbounded requirements never lock an app", () => {
  for (const p of [null, [], {}, { ...policy, schema: 2 }, { schema: 1, ios: null },
    ...[{ minimumBuild: "28" }, { minimumBuild: -1 }, { minimumBuild: 1.1 }, { message: "" }, { message: "x".repeat(401) },
      { expiresAt: "never" }, { expiresAt: "2026-10-29T00:00:00Z" }].map(patch => ({ ...policy, ios: { ...rule, ...patch } })),
  ]) expect(parseUpdatePolicy(p, NOW)).toBeNull();
  expect(parseUpdatePolicy(policy, NOW)).toEqual(policy);
  expect(parseUpdatePolicy({ schema: 1, ios: null, web: null }, NOW)).not.toBeNull();
});

function harness() {
  let now = NOW, cache: string | null = null;
  let respond: () => Promise<Response> = async () => Response.json(policy);
  const events: (UpdateRule | null)[] = [];
  const fetcher = mock((..._: unknown[]) => respond());
  const check = new ClientUpdateCheck({ platform: "ios", build: 27, now: () => now,
    load: async () => cache, save: async text => { cache = text; }, changed: r => events.push(r), fetch: fetcher as unknown as typeof fetch });
  return { check, events, fetcher, get cache() { return cache; }, cachePolicy: () => { cache = JSON.stringify(policy); },
    time: (value: number) => { now = value; }, response: (fn: () => Promise<Response>) => { respond = fn; } };
}

test("checks independently of the backend, without credentials, and caches the result", async () => {
  const h = harness();
  expect(await h.check.check()).toBe(true);
  expect(h.events.at(-1)).toEqual(rule);
  expect(h.fetcher.mock.calls[0]).toMatchObject([CLIENT_UPDATE_URL, { credentials: "omit", cache: "no-store", redirect: "error" }]);
  expect(JSON.parse(h.cache!)).toEqual(policy);
  await h.check.check();
  expect(h.fetcher).toHaveBeenCalledTimes(1);
});

test("an outage or malformed response retains a cached rule only until expiry", async () => {
  const h = harness(); h.cachePolicy(); await h.check.restore();
  expect(h.events.at(-1)).toEqual(rule);
  for (const response of [async () => { throw new Error("offline"); }, async () => new Response("html"), async () => Response.json({}, { status: 503 }), async () => Response.json({ schema: 2 })]) {
    h.response(response); expect(await h.check.check(true)).toBe(false); expect(h.events.at(-1)).toEqual(rule);
  }
  h.time(Date.parse(rule.expiresAt)); await h.check.check(true);
  expect(h.events.at(-1)).toBeNull();
});

test("rollback clears the gate and saved policy immediately", async () => {
  const h = harness(); await h.check.check();
  h.response(async () => Response.json({ schema: 1, ios: null, web: null }));
  await h.check.check(true);
  expect(h.events.at(-1)).toBeNull();
  expect(JSON.parse(h.cache!).ios).toBeNull();
});

test("foreground and manual checks coalesce, and slow storage cannot restore a revoked policy", async () => {
  let release!: (value: string) => void;
  const changes: (UpdateRule | null)[] = [];
  const fetcher = mock(async () => Response.json({ schema: 1, ios: null, web: null }));
  const checker = new ClientUpdateCheck({ platform: "ios", build: 27, now: () => NOW,
    load: () => new Promise(resolve => { release = resolve; }), save: async () => {}, changed: r => changes.push(r), fetch: fetcher as unknown as typeof fetch });
  const restoring = checker.restore();
  await Promise.all([checker.check(), checker.check(true), checker.check()]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  release(JSON.stringify(policy)); await restoring;
  expect(changes.every(r => r === null)).toBe(true);
});

test("a storage failure does not prevent a fresh update requirement", async () => {
  const changes: (UpdateRule | null)[] = [];
  const checker = new ClientUpdateCheck({ platform: "ios", build: 27, now: () => NOW,
    load: async () => { throw Error(); }, save: async () => { throw Error(); }, changed: r => changes.push(r),
    fetch: mock(async () => Response.json(policy)) as unknown as typeof fetch });
  await checker.restore(); expect(await checker.check()).toBe(true);
  expect(changes.at(-1)).toEqual(rule);
});
