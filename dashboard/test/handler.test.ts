import { expect, test } from 'bun:test';
import { handle, type Env } from '../src/handler';
const assets = { '/': { body: '<h1>Private</h1>', type: 'text/html' }, '/app.js': { body: 'private();', type: 'text/javascript' } };
const access = { aud: 'owner-app', getIdentity: async () => ({ email: 'owner@example.test' }) };
const request = (path = '/', headers = {}) => new Request('https://admin.example.test' + path, { headers });
function env() { const paths: string[] = []; return { paths, value: { ACCESS_AUD: 'owner-app', OPERATIONS: { fetch: async (r: Request) => { paths.push(r.url); return Response.json({ stats: { generatedAt: 'now' }, monitor: null, errors: [] }); } } } satisfies Env }; }

test('HTML, scripts and JSON all refuse missing Access, even with forged headers', async () => {
  const e = env();
  for (const path of ['/', '/app.js', '/statistics', '/api/dashboard']) {
    const response = await handle(request(path, { 'cf-access-authenticated-user-email': 'owner@example.test', 'cf-access-jwt-assertion': 'forged' }), e.value, undefined, assets);
    expect(response.status).toBe(403); expect(await response.text()).not.toContain('Private');
    expect(response.headers.get('cache-control')).toContain('no-store');
  }
  expect(e.paths).toEqual([]);
});
test('missing audience, wrong application, missing human identity, and verification failure stay closed', async () => {
  const e = env();
  expect((await handle(request(), { ...e.value, ACCESS_AUD: undefined }, access, assets)).status).toBe(403);
  expect((await handle(request(), e.value, { ...access, aud: 'other-app' }, assets)).status).toBe(403);
  expect((await handle(request(), e.value, { ...access, getIdentity: async () => undefined }, assets)).status).toBe(403);
  expect((await handle(request(), e.value, { ...access, getIdentity: async () => { throw Error('private detail'); } }, assets)).status).toBe(503);
  expect(e.paths).toEqual([]);
});
test('an authenticated administrator can open both pages with a restrictive policy', async () => {
  for (const path of ['/', '/statistics']) {
    const r = await handle(request(path), env().value, access, assets);
    expect(r.status).toBe(200); expect(await r.text()).toContain('Private');
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(r.headers.get('content-security-policy')).not.toContain('unsafe-inline');
  }
});
test('only allowlisted read routes/windows are forwarded; no alert or check actions', async () => {
  const e = env();
  for (const range of ['1h', '24h', '7d']) expect((await handle(request('/api/dashboard?window=' + range), e.value, access, assets)).status).toBe(200);
  expect(e.paths).toHaveLength(3);
  for (const range of ['__proto__', "1h' OR 1=1", '30d']) expect((await handle(request('/api/dashboard?window=' + encodeURIComponent(range)), e.value, access, assets)).status).toBe(400);
  for (const path of ['/ops/check', '/ops/test-alert', '/constructor', '/toString']) expect((await handle(request(path), e.value, access, assets)).status).toBe(404);
  expect((await handle(new Request('https://admin.example.test/api/dashboard', { method: 'POST' }), e.value, access, assets)).status).toBe(405);
  expect((await handle(new Request('http://admin.example.test/'), e.value, access, assets)).status).toBe(403);
  expect(e.paths).toHaveLength(3);
});
test('upstream failure returns an error without private exception details', async () => {
  for (const fetch of [async () => new Response('secret', { status: 503 }), async () => { throw Error('secret'); }]) {
    const r = await handle(request('/api/dashboard'), { ACCESS_AUD: 'owner-app', OPERATIONS: { fetch } }, access, assets);
    expect(r.status).toBe(502); expect(await r.text()).not.toContain('secret');
  }
});
