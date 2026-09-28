import { expect, test } from 'bun:test';
import { StatsCache } from '../src/stats-cache';
test('concurrent dashboard tabs share one query and reuse the result for a minute', async () => {
  let now = 0, calls = 0;
  const cache = new StatsCache(async (range) => { calls++; await Bun.sleep(5); return { range, calls }; }, () => now);
  const data = await Promise.all(Array.from({ length: 15 }, () => cache.get('1h')));
  expect(calls).toBe(1); expect(data.every((d) => d === data[0])).toBe(true);
  now = 59999; await cache.get('1h'); expect(calls).toBe(1);
  await cache.get('24h'); expect(calls).toBe(2);
  now = 60000; await cache.get('1h'); expect(calls).toBe(3);
});
test('failed refresh does not return stale success and the next attempt can recover', async () => {
  let now = 0, fail = false, calls = 0;
  const cache = new StatsCache(async () => { calls++; if (fail) throw Error('failed'); return 'ok'; }, () => now);
  await cache.get('1h'); now = 60000; fail = true;
  await expect(cache.get('1h')).rejects.toThrow('failed');
  fail = false; expect(await cache.get('1h')).toBe('ok'); expect(calls).toBe(3);
  await expect(cache.get('__proto__')).rejects.toThrow('invalid'); expect(calls).toBe(3);
});
test('usage cache coalesces requests for fifteen minutes independently of statistics windows', async () => {
  let now = 0, calls = 0;
  const cache = new StatsCache(async () => { calls++; return calls; }, () => now, 900000);
  await Promise.all([cache.get('1h'), cache.get('1h')]);
  now = 899999; expect(await cache.get('1h')).toBe(1);
  now = 900000; expect(await cache.get('1h')).toBe(2);
});
