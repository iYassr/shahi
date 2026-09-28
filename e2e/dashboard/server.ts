// Local fixture only. No production credentials or outbound service requests.
import { handle } from '../../dashboard/src/handler';
import { fixture } from './fixture';
const root = new URL('../../', import.meta.url);
const assets = Object.fromEntries(await Promise.all([
  ['/', 'dashboard/src/index.html', 'text/html'], ['/app.js', 'dashboard/src/app.client.js', 'text/javascript'],
  ['/style.css', 'dashboard/src/style.css', 'text/css'], ['/favicon.svg', 'site/public/favicon.svg', 'image/svg+xml'],
].map(async ([path, file, type]) => [path!, { body: await Bun.file(new URL(file!, root)).text(), type: type! }])));
Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.SHAHI_DASHBOARD_TEST_PORT ?? 7999), fetch: async (request) => {
  const url = new URL(request.url); url.protocol = 'https:';
  return handle(new Request(url, request), {
    ACCESS_AUD: 'test-audience', OPERATIONS: { fetch: async r => Response.json(fixture(new URL(r.url).searchParams.get('window') ?? '1h')) },
  }, { aud: 'test-audience', getIdentity: async () => ({ email: 'fixture@example.test' }) }, assets);
} });
