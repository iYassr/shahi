const $ = (id) => document.getElementById(id);
const number = (v) => v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
const count = (v) => number(v) === null ? '—' : new Intl.NumberFormat().format(Math.round(Number(v)));
function bytes(v) {
  let n = number(v); if (n === null) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toLocaleString(undefined, { maximumFractionDigits: i ? 1 : 0 })} ${units[i]}`;
}
const ms = (v) => number(v) === null ? '—' : `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })} ms`;
const usd = (v) => number(v) === null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(Number(v));
const percent = (n, total) => total > 0 ? `${(100 * n / total).toFixed(1)}%` : '—';
const duration = (v) => number(v) === null ? '—' : `${(Number(v) / 60000).toLocaleString(undefined, { maximumFractionDigits: 1 })} min`;
const timestamp = (v) => typeof v === 'string' ? Date.parse(/Z$|[+-]\d\d:\d\d$/.test(v) ? v : v.replace(' ', 'T') + 'Z') : NaN;
const date = (v) => Number.isFinite(timestamp(v)) ? new Date(timestamp(v)).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Unknown time';
function element(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
function rows(id, items) {
  const root = $(id); root.replaceChildren();
  for (const [label, value, style] of items) { const row = element('div', undefined, 'row'); row.append(element('span', label), element('span', value, `row-value ${style ?? ''}`)); root.append(row); }
}
function table(id, labels, items, missing = false) {
  const root = $(id); root.replaceChildren();
  if (!items.length) { root.append(element('p', missing ? 'Data unavailable.' : 'No events in this range.', 'empty')); return; }
  const t = element('table'); const head = element('thead'); const hr = element('tr');
  for (const label of labels) { const th = element('th', label); th.scope = 'col'; hr.append(th); }
  head.append(hr); t.append(head); const body = element('tbody');
  for (const item of items) { const tr = element('tr'); for (const value of item) tr.append(element('td', value)); body.append(tr); }
  t.append(body); root.append(t);
}
const names = {
  website: 'Public website', browser_app: 'Browser app', signup_api: 'Beta signup API', relay_http: 'Relay endpoint', relay_tunnel: 'Encrypted tunnel round trip', analytics: 'Analytics', signup_delivery_errors: 'Signup delivery', relay_errors: 'Relay errors', connection_rejections: 'Connection rate limits', authentication_failures: 'Computer authentication', reconnect_storm: 'Reconnect activity', service_latency: 'Service response times',
  box_auth: 'Computer authenticated', box_gone: 'Computer disconnected', box_presence: 'Computer presence', phone_open: 'Phone opened', phone_close: 'Phone closed', refused: 'Refused', connect: 'Connection attempt', rate_limited: 'Front-door rate limit', traffic: 'Traffic batch', auth_failed: 'Authentication failed', internal_error: 'Internal error',
};
const expected = ['website', 'browser_app', 'signup_api', 'relay_http', 'relay_tunnel', 'analytics', 'signup_delivery_errors', 'relay_errors', 'connection_rejections', 'authentication_failures', 'reconnect_storm', 'service_latency'];
let data = null;
let active = null;
let selected = '1h';
function reliability(stats) {
  const outcomes = Array.isArray(stats?.outcomes) ? stats.outcomes : null;
  const sum = (kind, reasons) => outcomes?.filter(r => r.kind === kind && (!reasons || reasons.includes(r.reason))).reduce((n, r) => n + (number(r.n) ?? 0), 0) ?? null;
  const auth = sum('box_auth'), failed = sum('auth_failed'), pending = sum('refused', ['too many pending boxes']);
  const opened = sum('phone_open'), refused = sum('refused', ['box offline', 'too many phones']);
  rows('reliability', [
    ['Computer authentication rate', outcomes ? percent(auth, auth + failed + pending) : '—'],
    ['Authenticated / failed or refused', outcomes ? `${count(auth)} / ${count(failed + pending)}` : '—'],
    ['Phone admission rate', outcomes ? percent(opened, opened + refused) : '—'],
    ['Phone links opened / refused', outcomes ? `${count(opened)} / ${count(refused)}` : '—'],
    ['Computer disconnects', count(sum('box_gone'))],
    ['Phones closed: computer offline', count(sum('phone_close', ['box offline']))],
    ['Phones closed: send failed', count(sum('phone_close', ['send failed']))],
  ]);
  const handshake = stats?.boxHandshake;
  const measured = number(handshake?.n) > 0;
  const phone = stats?.durations?.find(r => r.kind === 'phone_close');
  rows('performance', [['Computer handshakes measured', count(handshake?.n)],
    ['Handshake median (p50)', ms(measured ? handshake.p50Ms : null)], ['Handshake p95', ms(measured ? handshake.p95Ms : null)],
    ['Handshake p99', ms(measured ? handshake.p99Ms : null)],
    ['Closed phone connections: median duration', duration(number(phone?.n) > 0 ? phone.p50Ms : null)],
    ['Closed phone connections: p95 duration', duration(number(phone?.n) > 0 ? phone.p95Ms : null)]]);
  const samples = stats?.capacity?.filter(r => Number.isFinite(timestamp(r.at)) && ['computers', 'phones', 'busiestComputer'].every(k => number(r[k]) !== null && Number(r[k]) >= 0));
  const peak = (key) => samples?.length ? Math.max(...samples.map(r => Number(r[key]))) : null;
  rows('capacity', [['Peak sampled computers', count(peak('computers'))], ['Peak sampled phone links', count(peak('phones'))],
    ['Busiest observed computer', peak('busiestComputer') === null ? '—' : `${count(peak('busiestComputer'))} / 8 phone slots`], ['Five-minute buckets observed', count(samples?.length)]]);
  table('capacity-table', ['Bucket start', 'Computers', 'Phone links'], (samples ?? []).slice(-48).map(r => [date(r.at), count(r.computers), count(r.phones)]), !stats?.capacity);
}
function budget() {
  const amount = number($('budget').value), total = number(data?.usage?.model?.totalUsd);
  const age = Date.now() - timestamp(data?.usage?.generatedAt);
  $('budget-state').className = 'caption';
  if (amount === null || amount <= 0) { $('budget-state').textContent = 'Enter a budget to compare with this projection. Kept only while this page is open; no email is sent.'; return; }
  if (total === null || !Number.isFinite(age) || age > 1200000 || age < -60000) { $('budget-state').textContent = 'Usage unavailable or stale; budget status is unknown.'; return; }
  $('budget-state').textContent = `${usd(total)} projected subtotal · ${percent(total, amount)} of ${usd(amount)} budget. ${total >= amount ? 'Projection exceeds this budget.' : total >= amount * .8 ? 'Projection is approaching this budget.' : 'Projection is below this budget.'} Excluded charges can increase actual spending.`;
  if (total >= amount * .8) $('budget-state').className = 'notice';
}
function usage() {
  const u = data?.usage;
  $('usage-time').textContent = u ? `${date(u.since)} – ${date(u.until)} · seven-day window` : 'Cloudflare usage unavailable.';
  table('usage', ['Metric', 'Shahi', 'Account'], u ? [
    ['Worker invocations', count(u.shahi.workerRequests), count(u.account.workerRequests)],
    ['Worker CPU (ms)', count(u.shahi.workerCpuMs), count(u.account.workerCpuMs)],
    ['DO request units (planning)', count(u.shahi.durableRequests), count(u.account.durableRequests)],
    ['DO duration (GB-s)', count(u.shahi.durableDurationGbSeconds), count(u.account.durableDurationGbSeconds)],
    ['SQLite rows read', count(u.shahi.rowsRead), count(u.account.rowsRead)], ['SQLite rows written', count(u.shahi.rowsWritten), count(u.account.rowsWritten)],
  ] : [], !u);
  table('worker-usage', ['Worker', 'Invocations', 'CPU (ms)', 'Errors'], (u?.workers ?? []).map(r => [r.name, count(r.requests), count(r.cpuMs), count(r.errors)]), !u);
  const costs = u?.model?.costs;
  rows('cost', [['Projected 30-day subtotal', usd(u?.model?.totalUsd)], ['Base subscription', usd(costs?.subscription)],
    ['Worker requests & CPU', usd(costs ? costs.workerRequests + costs.workerCpu : null)],
    ['Durable Object requests & duration', usd(costs ? costs.durableRequests + costs.durableDuration : null)],
    ['SQLite row operations', usd(costs ? costs.rowsRead + costs.rowsWritten : null)]]);
  budget();
}
$('budget').addEventListener('input', budget);
function setPage() {
  const stats = location.pathname === '/statistics';
  document.title = `${stats ? 'Statistics' : 'Dashboard'} · Shahi`;
  $('title').textContent = stats ? 'Statistics' : 'Overview';
  $('subtitle').textContent = stats ? 'Traffic, connections, and reliability across your fleet.' : 'A clear view of your service, from connection to delivery.';
  $('overview-panels').hidden = stats; $('statistics-panels').hidden = !stats;
  document.querySelectorAll('[data-page]').forEach((a) => { if ((a.dataset.page === 'statistics') === stats) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
}
document.querySelectorAll('[data-page]').forEach((a) => a.addEventListener('click', (e) => { if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); history.pushState({}, '', a.getAttribute('href')); setPage(); }));
window.addEventListener('popstate', setPage);
function health(monitor) {
  const elapsed = Date.now() - timestamp(monitor?.checkedAt);
  const stale = !Number.isFinite(elapsed) || elapsed > 180000 || elapsed < -60000;
  const checks = monitor?.checks ?? {};
  const complete = expected.every((key) => typeof checks[key]?.healthy === 'boolean');
  const incidentList = Object.entries(monitor?.incidents ?? {}).filter(([, incident]) => incident.firing);
  const failed = Object.entries(checks).filter(([, check]) => check.healthy === false);
  let title = 'All monitored services healthy', detail = 'The latest sample passed every check.', state = 'good';
  if (stale || !complete) { title = 'Service health unknown'; detail = stale ? 'No recent monitor sample. Refresh or check the monitor.' : 'Some checks are unavailable. Overall health cannot be confirmed.'; state = 'unknown'; }
  else if (incidentList.length) { title = `${incidentList.length} active incident${incidentList.length === 1 ? '' : 's'}`; detail = 'An incident remains open until two consecutive healthy samples.'; state = 'error'; }
  else if (failed.length) { title = 'Checks need attention'; detail = 'A check failed. Three consecutive failures open an incident.'; state = 'warning'; }
  $('health-banner').dataset.state = state; $('health-title').textContent = title; $('health-detail').textContent = detail;
  $('health-time').textContent = monitor ? `Checked ${date(monitor.checkedAt)}` : 'No sample';
  rows('checks', expected.map((key) => { const c = checks[key]; return [names[key], !c || stale ? 'Unknown' : c.healthy ? `Healthy${c.durationMs > 0 ? ' · ' + ms(c.durationMs) : ''}` : 'Failed', !c || stale ? 'warn' : c.healthy ? 'good' : 'bad']; }));
  rows('incidents', incidentList.length ? incidentList.map(([key, i]) => [names[key] ?? key, `${count(i.failures)} consecutive failures`, 'bad']) : [[stale || !complete ? 'Current incidents unknown' : 'No active incidents', stale || !complete ? '—' : 'Clear', stale || !complete ? 'warn' : 'good']]);
  $('delivery').textContent = monitor ? `${count(monitor.deliveryFailures)} alert email delivery failures recorded by the monitor. Counts are cumulative, not limited to the selected range.` : 'Alert delivery data unavailable.';
}
function drawChart(stats) {
  const chart = $('chart'); chart.replaceChildren();
  const sec = number(stats?.bucketSeconds), duration = number(stats?.seconds), end = timestamp(stats?.generatedAt);
  if (!sec || !duration || !Number.isFinite(end) || !Array.isArray(stats?.timeline)) {
    chart.append(element('p', 'Activity data unavailable.', 'chart-empty')); chart.setAttribute('aria-label', 'Connection activity unavailable');
    $('chart-total').textContent = '—'; $('chart-start').textContent = '—'; $('chart-end').textContent = '—'; table('chart-table', [], [], true); return;
  }
  const interval = sec * 1000, start = Math.floor((end - duration * 1000) / interval) * interval;
  const bins = new Map();
  for (let t = start; t <= end; t += interval) bins.set(t, 0);
  for (const row of stats.timeline) {
    if (row.kind !== 'connect') continue;
    const t = timestamp(row.at), n = number(row.n);
    if (bins.has(t) && n !== null) bins.set(t, bins.get(t) + n);
  }
  const values = [...bins]; const max = Math.max(0, ...values.map(([, n]) => n)); const total = values.reduce((sum, [, n]) => sum + n, 0);
  chart.setAttribute('aria-label', `${count(total)} connection attempts, ${sec / 60}-minute buckets. Data table follows.`);
  if (!total) chart.append(element('p', 'No connection attempts in this range.', 'chart-empty'));
  else for (const [at, n] of values) {
    const slot = element('div', undefined, 'bar-slot'), bar = element('div', undefined, 'bar');
    bar.style.height = `${n / max * 100}%`; slot.title = `${date(new Date(at).toISOString())}: ${count(n)} attempts`; slot.append(bar); chart.append(slot);
  }
  $('chart-total').textContent = `${count(total)} attempts`;
  $('chart-start').textContent = date(new Date(end - duration * 1000).toISOString()); $('chart-end').textContent = date(stats.generatedAt);
  table('chart-table', ['Bucket start (local time)', 'Attempts'], values.map(([at, n]) => [date(new Date(at).toISOString()), count(n)]));
}
function render() {
  const stats = data?.stats;
  const events = Object.fromEntries((stats?.eventsByKind ?? []).map((r) => [r.kind, number(r.n)]));
  const traffic = stats?.traffic;
  $('computers').textContent = count(stats?.boxesOnlineEstimate);
  $('phones').textContent = stats ? count(events.phone_open ?? 0) : '—';
  $('errors').textContent = stats ? count(events.internal_error ?? 0) : '—';
  $('traffic').textContent = traffic && number(traffic.upBytes) !== null && number(traffic.downBytes) !== null ? bytes(Number(traffic.upBytes) + Number(traffic.downBytes)) : '—';
  health(data?.monitor); drawChart(stats); reliability(stats); usage();
  rows('transfer', [['Phone → computer', bytes(traffic?.upBytes)], ['Computer → phone', bytes(traffic?.downBytes)], ['Frames to computers', count(traffic?.upFrames)], ['Frames to phones', count(traffic?.downFrames)], ['Mean computer handshake', ms(stats?.boxHandshake?.meanMs)], ['Maximum computer handshake', ms(stats?.boxHandshake?.maxMs)]]);
  table('regions', ['Edge location', 'Attempts'], (stats?.connectsByColo ?? []).map((r) => [r.colo || 'Unknown', count(r.n)]), !stats);
  table('events', ['Event', 'Count'], (stats?.eventsByKind ?? []).map((r) => [names[r.kind] ?? r.kind, count(r.n)]), !stats);
  table('refusals', ['Reason', 'Count'], (stats?.refusalsByReason ?? []).map((r) => [r.reason || 'Unspecified', count(r.n)]), !stats);
  table('closes', ['Close code', 'Count'], (stats?.phoneCloseCodes ?? []).map((r) => [String(r.code), count(r.n)]), !stats);
  table('signups', ['HTTP status', 'Requests', 'Mean time'], (stats?.signupWindow ?? []).map((r) => [String(r.status), count(r.n), ms(r.meanMs)]), !stats);
  const errors = [...(data?.errors ?? [])];
  const age = Date.now() - timestamp(stats?.generatedAt);
  if (stats && (!Number.isFinite(age) || age > 180000 || age < -60000)) errors.push('Statistics are stale. Values below are from the last available sample.');
  const usageAge = Date.now() - timestamp(data?.usage?.generatedAt);
  if (data?.usage && (!Number.isFinite(usageAge) || usageAge > 1200000 || usageAge < -60000)) errors.push('Cloudflare usage is stale; cost projections use the last available sample.');
  $('error').textContent = errors.join(' '); $('error').hidden = errors.length === 0;
  $('updated').textContent = stats ? `Statistics sampled ${date(stats.generatedAt)}` : 'Statistics unavailable';
}
async function refresh() {
  active?.abort(); const controller = new AbortController(); active = controller;
  const timer = setTimeout(() => controller.abort(), 25000);
  $('refresh').disabled = true; $('content').setAttribute('aria-busy', 'true');
  try {
    const response = await fetch(`/api/dashboard?window=${selected}`, { cache: 'no-store', signal: controller.signal, redirect: 'error', headers: { accept: 'application/json' } });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('unavailable');
    const next = await response.json();
    if (!next || typeof next !== 'object' || !Array.isArray(next.errors)) throw new Error('invalid data');
    if (active !== controller) return;
    data = next; render();
  } catch {
    if (active !== controller) return;
    data = null; render(); $('error').hidden = false;
    $('error').replaceChildren(element('span', 'Live data could not be loaded. Refresh to retry, or '));
    const login = element('a', 'sign in again'); login.href = '/cdn-cgi/access/logout'; $('error').append(login, '.');
  } finally {
    clearTimeout(timer);
    if (active === controller) { active = null; $('refresh').disabled = false; $('content').setAttribute('aria-busy', 'false'); }
  }
}
$('refresh').addEventListener('click', refresh);
$('window').addEventListener('change', () => { selected = $('window').value; data = null; render(); refresh(); });
setInterval(() => { if (!document.hidden && !active) refresh(); else if (data) render(); }, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
setPage(); refresh();
