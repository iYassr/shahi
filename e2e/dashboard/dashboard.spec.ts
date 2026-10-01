import { expect, test } from '@playwright/test';
import { fixture } from './fixture';

test.beforeEach(async ({ page }) => {
  await page.route('**/*', async route => {
    expect(new URL(route.request().url()).hostname).toBe('127.0.0.1');
    await route.continue();
  });
});
test('overview, statistics, range selection and chart remain usable on desktop and phone', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'All monitored services healthy' })).toBeVisible();
  await expect(page.locator('#phones')).toHaveText('642');
  await expect(page.locator('.bar')).toHaveCount(13);
  expect(await page.locator('.bar').last().evaluate(e => e.getBoundingClientRect().height)).toBeGreaterThan(20);
  await page.getByRole('link', { name: 'Statistics', exact: false }).click();
  await expect(page).toHaveURL(/statistics$/);
  await expect(page.getByRole('heading', { name: 'Traffic & handshake' })).toBeVisible();
  await page.getByLabel('Time range').selectOption('7d');
  await expect(page.locator('#content')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#chart')).toHaveAttribute('aria-label', /360-minute/);
  await page.reload(); await expect(page.locator('#title')).toHaveText('Statistics');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  expect(errors).toEqual([]);
});
test('stale or incomplete health can never appear healthy', async ({ page }) => {
  const data = fixture(); data.monitor.checkedAt = new Date(Date.now() - 600000).toISOString();
  await page.route('**/api/dashboard?*', route => route.fulfill({ json: data }));
  await page.goto('/'); await expect(page.locator('#health-title')).toHaveText('Service health unknown');
  await expect(page.locator('#checks')).not.toContainText('Healthy');
  data.monitor.checkedAt = new Date().toISOString(); delete data.monitor.checks.relay_tunnel;
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.locator('#health-detail')).toContainText('Some checks are unavailable');
});
test('failed API clears prior values and retry recovers', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#phones')).toHaveText('642');
  await page.route('**/api/dashboard?*', route => route.fulfill({ status: 502, body: 'unavailable' }));
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('alert')).toContainText('could not be loaded');
  await expect(page.locator('#phones')).toHaveText('—');
  await expect(page.locator('#health-title')).toHaveText('Service health unknown');
  await page.unroute('**/api/dashboard?*'); await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.locator('#phones')).toHaveText('642'); await expect(page.getByRole('alert')).toBeHidden();
});
test('partial outage keeps monitor health but does not manufacture zero metrics', async ({ page }) => {
  await page.route('**/api/dashboard?*', route => route.fulfill({ json: { ...fixture(), stats: null, errors: ['Statistics unavailable.'] } }));
  await page.goto('/statistics');
  await expect(page.locator('#health-title')).toHaveText('All monitored services healthy');
  await expect(page.locator('#traffic')).toHaveText('—');
  await expect(page.locator('#regions')).toHaveText('Data unavailable.');
});
test('dynamic labels render as text; empty range and absent handshake stay honest', async ({ page }) => {
  const data = fixture(); data.stats.eventsByKind = []; data.stats.timeline = []; data.stats.refusalsByReason = [{ reason: '<img src=x onerror=alert(1)>', n: 3 }];
  Object.assign(data.stats.boxHandshake, { meanMs: null, maxMs: null });
  await page.route('**/api/dashboard?*', route => route.fulfill({ json: data }));
  await page.goto('/statistics');
  await expect(page.locator('#phones')).toHaveText('0');
  await expect(page.locator('#chart')).toHaveText('No connection attempts in this range.');
  await expect(page.locator('#refusals')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('#refusals img')).toHaveCount(0);
  await expect(page.locator('#transfer')).toContainText('Mean computer handshake—');
});
test('reliability, concurrency and cost models explain their units and budget comparison', async ({ page }) => {
  await page.goto('/statistics');
  await expect(page.locator('#reliability')).toContainText('97.6%');
  await expect(page.locator('#performance')).toContainText('Handshake p95510 ms');
  await expect(page.locator('#capacity')).toContainText('6 / 8 phone slots');
  await expect(page.locator('#cost')).toContainText('$17.50');
  await expect(page.locator('#cost')).toContainText('Containers$28.50');
  await expect(page.locator('#usage')).toContainText('2,419,200');
  await expect(page.locator('#usage')).toContainText('12,300');
  await page.getByLabel('Planning budget').fill('20');
  await expect(page.locator('#budget-state')).toContainText('87.5%');
  await expect(page.locator('#budget-state')).toContainText('approaching');
  await page.getByLabel('Planning budget').fill('10');
  await expect(page.locator('#budget-state')).toContainText('exceeds');
  await page.getByLabel('Time range').selectOption('24h');
  await expect(page.locator('#content')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#cost')).toContainText('$17.50');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('missing or empty observations cannot manufacture perfect success, zero peaks or a cheap bill', async ({ page }) => {
  const data = fixture(); data.stats.outcomes = []; data.stats.capacity = []; data.stats.boxHandshake.n = 0;
  await page.route('**/api/dashboard?*', route => route.fulfill({ json: { ...data, usage: null, errors: ['Cloudflare usage unavailable.'] } }));
  await page.goto('/statistics');
  await expect(page.locator('#reliability')).toContainText('Computer authentication rate—');
  await expect(page.locator('#performance')).toContainText('Handshake p95—');
  await expect(page.locator('#capacity')).toContainText('Peak sampled phone links—');
  await expect(page.locator('#cost')).toContainText('Projected 30-day subtotal—');
  await page.getByLabel('Planning budget').fill('20');
  await expect(page.locator('#budget-state')).toContainText('unknown');
  await expect(page.locator('#phones')).toHaveText('642');
});
test('stale usage cannot report a safe budget even while connection statistics are fresh', async ({ page }) => {
  const data = fixture(); data.usage.generatedAt = new Date(Date.now() - 1800000).toISOString();
  await page.route('**/api/dashboard?*', route => route.fulfill({ json: data }));
  await page.goto('/statistics');
  await page.getByLabel('Planning budget').fill('100');
  await expect(page.locator('#budget-state')).toContainText('unknown');
  await expect(page.getByRole('alert')).toContainText('Cloudflare usage is stale');
  await expect(page.locator('#phones')).toHaveText('642');
});

test('container usage the relay could not read is unavailable, never a free line', async ({ page }) => {
  const data = fixture();
  data.usage.containers = null as never;
  data.usage.model = { ...data.usage.model, containers: 'unavailable', costs: { ...data.usage.model.costs, containerMemory: undefined, containerCpu: undefined, containerDisk: undefined } } as never;
  await page.route('**/api/dashboard?*', route => route.fulfill({ json: data }));
  await page.goto('/statistics');
  await expect(page.locator('#cost')).toContainText('ContainersUnavailable');
  await expect(page.locator('#usage')).toContainText('Unavailable');
});
