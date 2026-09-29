# Running it

What is deployed, where its state lives, and what to do when something is wrong.
Written for the moment you need it rather than for reading through.

## The shape of a deployment

The plugin's startup hook installs a user service that supervises the sidecar;
the sidecar owns herdr's unix socket and answers the phone.

```
phone ──sealed frames──> relay ──> sidecar (bun) ──unix socket──> herdr
                                   launchd or systemd --user
```

The relay is the default and needs nothing configured: the box dials out and
holds the connection open, so there is no inbound port and no domain. The one
alternative is an SSH tunnel to the same loopback bind, for someone who wants
no third party in the path. See [connectivity.md](connectivity.md) for the
choice, and [relay.md](relay.md) for what the relay can and cannot see.

`RELAY_URL=` (empty) in the plugin's `.env` opts out of the relay entirely; the
phone then reaches the box over SSH.

**Do not put this port on a network.** Both transports arrive at `127.0.0.1`,
so nothing needs it exposed — and it runs arbitrary commands as you. That goes
double for `tailscale funnel`, which would publish it to the internet.

The port also answers only requests whose `Host` is `127.0.0.1`, `localhost`
or `[::1]` (any port), which is what stops a DNS-rebinding page from reaching
it. A 403 saying "Shahi answers only at 127.0.0.1 or localhost. Connect through
the relay or an SSH tunnel…" means the request came through a reverse proxy or
a hosts-file name. A proxy of your own, such as `tailscale serve`, works once
its full host name is in `SHAHI_ALLOWED_HOSTS` (comma-separated, no ports or
wildcards) in the plugin's `.env`, followed by `shahi.restart`; a malformed
entry stops the sidecar from starting.

## Standing it up

```sh
herdr plugin install iYassr/shahi
herdr plugin action invoke shahi.pair
```

The first builds and registers the plugin; the second installs the service if it
is missing and prints a pairing QR. Reinstalling upgrades in place and keeps
your passcode.

The service always restarts on install, deliberately: `enable --now` does
nothing to a running service, so an in-place upgrade once left the old code
running from memory while looking applied.

**On a headless Linux box, run `loginctl enable-linger $USER` once.** Without
it the user service stops when your last SSH session ends — exactly when you
would want to reach it from a phone. The plugin cannot do this for you because
it needs sudo on some distributions.

Setup run from a shell with no login session of its own (`su`, `sudo -iu`, some
containers) finds no user systemd to talk to, and says so instead of passing on
"Failed to connect to user scope bus": start herdr from a real login as that
user, or `sudo loginctl enable-linger <user>`, and if the shell has no
`XDG_RUNTIME_DIR`, `export XDG_RUNTIME_DIR=/run/user/<uid>` before starting
herdr. Then `herdr plugin action invoke shahi.restart`.

## Where things live

herdr gives the plugin two directories and keeps them apart from the checkout,
so an upgrade never touches your secrets or your data.

| what | where |
|---|---|
| the checkout | `$HERDR_PLUGIN_ROOT` — replaced on upgrade, never edit; the service does not run from it |
| releases | `$HERDR_PLUGIN_STATE_DIR/managed/` — the manager and the verified releases it runs |
| secrets | `$HERDR_PLUGIN_CONFIG_DIR/.env`, mode 0600 |
| database | `$HERDR_PLUGIN_STATE_DIR/shahi.sqlite` — devices, push, transcripts |
| log | `$HERDR_PLUGIN_STATE_DIR/shahi.log` |
| service | `~/Library/LaunchAgents/app.shahi.sidecar.plist`, or `~/.config/systemd/user/shahi.service` |

`herdr plugin action invoke shahi.status` prints the resolved paths, which beats
guessing at them.

The SQLite database holds the relay identity seed and paired-device secrets.
The `.env` holds the session secret, passcode hash and VAPID keys. Back up both
privately if you want to preserve pairing; losing the identity gives the box a
new `serverId`. Transcripts in the same database can contain private content.

## Everyday commands

```sh
herdr plugin action invoke shahi.status     # is it up, and where
herdr plugin action invoke shahi.logs       # what it is doing
herdr plugin action invoke shahi.restart    # after a change
herdr plugin action invoke shahi.pair       # add a phone
herdr plugin action invoke shahi.stop       # stop the service
herdr plugin action invoke shahi.uninstall  # service first, then the plugin
```

These work on both platforms. The underlying `launchctl` and `systemctl --user`
commands still work if you prefer them, but the actions are what the plugin
keeps in step.

**A managed service serves the web app inside its release**, not the
checkout's `web/dist`, so a change to `web/` reaches it only in a new approved
release. A development server run from a checkout serves `web/dist`: rebuild
(`bun run build:web`) and restart after touching `web/`.

## What healthy looks like

Startup prints the address and what it found (`shahi.logs` shows it):

```
listening on http://127.0.0.1:7171
  11 workspaces, 47 panes, 14 agents (0 blocked)
  passcode required
  push enabled, 1 subscription(s)
  devices 2 paired — pair a phone: herdr plugin action invoke shahi.pair
  relay dialling https://relay.getshahi.dev as <serverId>
  data /home/you/.local/state/herdr/plugins/shahi/shahi.sqlite
```

`shahi.status` adds whether the relay is connected and which Shahi release and
herdr version and protocol `/api/meta` reports. A herdr the running release is
not approved for puts the sidecar in its recovery state rather than printing a
warning: pairing and updates keep working, agent commands are refused, and the
app says which side to update (see [releases.md](releases.md)). A new herdr
protocol means something in `server/lib/herdr-schema.ts` may now be wrong —
regenerate with `bun run gen:types` and read the diff.

## When something is wrong

**The phone cannot reach it.** Work outwards. On the box,
`curl http://127.0.0.1:7171/api/meta` should answer. Then check
`shahi.status` for the relay state. If the relay is connected and the phone
still cannot reach it, the phone is probably paired to a different `serverId` —
re-pair. On the SSH path, check that the tunnel opens at all: a changed host
key is refused on purpose, and is reported as that rather than as a dead box.

**The app says the server is too old, or too new.** The contract version is
negotiated: `GET /api/meta` says what the sidecar speaks and every request
carries `x-shahi-api`. A mismatch is a 426 whose text names the side to update.
Update the sidecar with `herdr plugin install iYassr/shahi`.

**An agent stopped responding to the app.** Check the pane in herdr directly.
The app sends keystrokes; it cannot make an agent read them, and a pane whose
process has exited accepts input into nothing.

**The service looks installed but runs old code.** It follows the herdr that
ran the hook last. If you use named sessions, the one that started most
recently owns it — `shahi.status` prints the socket it is attached to.

**The header says HERDR OFFLINE.** The sidecar answers but herdr does not.
Start herdr; the sidecar reattaches without a new pairing.

**Status says the port is taken.** Another process owns the configured port.
Use the actual Shahi service or put `PORT=<free port>` in the plugin config
`.env` and restart. The native SSH form still forwards to 7171, so moving the
sidecar port requires using the relay or a separately configured tunnel.

**SSH connects but Shahi does not.** A changed host key, a server refusing
`AllowTcpForwarding`, and nothing listening on the sidecar port produce distinct
messages. Fix the stated cause; see [SSH](ssh.md).

## Replacing the passcode

```sh
herdr plugin action invoke shahi.reset-passcode
herdr plugin log list --plugin shahi        # the new passcode, printed once
```

Only the bcrypt hash is stored; the plaintext lives nowhere, so a lost passcode
is replaced rather than recovered. The session secret is left alone, so
sessions already signed in and paired devices stay signed in. To revoke one
phone instead, use Settings → Devices with access on another paired device —
revocation takes effect on its next request and on its open socket, and a
phone that was offline is signed out when it next connects through the relay.
There is no way to revoke a device from the computer itself; see
[pairing.md](pairing.md) for a lost phone that was your only one.

Note that the passcode `4821` appears in this repository's early history, in a
script that hardcoded it as a default. Rotating is the clean fix if that matters
to you.

## Backing up

Back up the private `.env` and a consistent SQLite backup, including its relay identity and device credentials. The checkout regenerates from the plugin repository.

## Release catalogs

A signed release catalog is valid for 120 days, and a computer refuses an
expired one: a fresh `herdr plugin install` then stops before anything is
staged, and installed managers stop finding updates, though an installed
release keeps running. `.github/workflows/catalog-expiry.yml` renews them. It
runs every Monday at 05:23 UTC, re-signs any channel with fewer than 30 days
left, and files a "Release catalog renewal failed" issue when it cannot. It can
also be dispatched by hand to renew now or to retire versions. GitHub pauses
scheduled workflows after 60 days without repository activity, so check that
it is still enabled; a paused schedule is a lapse waiting to happen.
[releases.md](releases.md) has the commands.

## Operational logs and request analytics

`herdr plugin action invoke shahi.logs` tails both startup output and the
private `operations.jsonl` beside the SQLite database. JSON logs rotate at
5 MiB into three archives (20 MiB total). Successful requests are sampled one
in 100 per route; slow requests and failures are logged, subject to a cap of
240 records/minute. `droppedLogs` exposes suppression. All request aggregates
remain counted. Logs are deliberately bounded under floods and disk errors.

Authenticated `GET /api/diagnostics` returns process uptime, RSS/heap, in-flight
handlers, route-template request counts, errors/rejections, latency histograms,
event counts (including `relay.protocol_mismatch` for outdated clients),
suppressed log count, relay state and active local alerts. The
histogram exposes bucket boundaries so a client can derive approximate
percentiles. It records handler time, not tap-to-render or complete file-transfer
time. Metrics reset at process restart and never contain terminal or file data.

Push delivery is recorded as `push.sent` and `push.failed` events carrying the
channel (`expo` or `web`), a count, an HTTP status and a fixed reason: Expo's
own ticket error code (`DeviceNotRegistered`, `MessageTooBig`, …), `push
refused`, `push timeout`, `push unreachable`, `push malformed response` or
`subscription gone`. Never a token, an endpoint or notification text. A send the
push service refuses for now (429 or 5xx) or never received is tried twice
more, after 2 and 10 seconds; one that timed out (15 seconds) is not, because
it may have been delivered.

A local summary is written every minute. Local alert transitions cover relay
outage after three minutes, at least ten 5xx responses and a 5% error rate in a
minute, RSS over 768 MiB, and timer lag over one second. They recover in the next
healthy sample. These local alerts are in the private log/diagnostic endpoint;
individual computers do not upload them to the fleet monitor.

## Fleet analytics and incident email

Cloudflare Workers Observability for `shahi-relay` contains structured
connection, refusal, authentication, traffic and duration events. Filter by
`event`, `detail`, `colo` or the stable pseudonymous `serverId`. Invocation logs
and automatic tracing are off. Workers Logs retain seven days on the paid plan;
Analytics Engine retains three months. Workers Logs have usage charges beyond the plan's included allowance. Analytics
Engine publishes usage-based allowances/prices but currently says billing has
not begun; consult [its pricing page](https://developers.cloudflare.com/analytics/analytics-engine/pricing/)
and [Workers Logs pricing](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
for current terms. Traffic is aggregated before recording.

These are server-side operational metrics. Optional client crash and Reader
diagnostics use bundled Sentry SDKs; see [client observability](observability.md). HTML responses send `Cache-Control: public, no-transform` to
prevent Cloudflare's automatic beacon injection, alongside the PWA's
`script-src 'self'` policy. The same directive disables Cloudflare's
compression, so the hashed app assets and the site's own CSS, JavaScript and SVG
omit it (`site/public/_headers`, [browser hosting](browser-hosting.md)). So does
the 404 page for a missing file under `/pwa/assets/`, which takes that path's
rule; the `/pwa/*` policy's `script-src 'self'` and the page's own
`default-src 'none'` are what refuse a beacon there.
Cloudflare documents the injection in its
[Web Analytics setup guide](https://developers.cloudflare.com/web-analytics/get-started/).
Verify public HTML with a browser User-Agent: a plain curl request can receive
different injection behavior. Worker subrequests do not exercise that injection
path, so the availability monitor alone cannot establish its absence.

`GET https://relay.getshahi.dev/stats` requires a separate bearer admin token.
It returns event/close/refusal/region breakdowns, bytes and frame counts,
handshake mean/max and sampling-weighted p50/p95/p99, signup statuses and mean timings from `shahi_site`, a five-minute timeline, recent presence estimates and
five-minute alert counters. Authenticated synthetic probes are excluded from fleet summaries. Presence is approximate and traffic is delayed
until the next alarm/close. Missing query credentials return 503; query failure
returns 502 rather than an empty healthy dashboard. All admin replies are
`no-store`. Never put the bearer token in a URL, browser storage, or source code.

The statistics page also compares completed computer-authentication outcomes and
phone admissions. A relay admission is not proof of successful pairing or phone
authentication. Outcomes can straddle time-window boundaries, and the denominator
includes rejected strangers and reconnects. No observations means an unknown rate,
not 100% success. Closed-connection duration is not reconnect recovery time.

Concurrency uses the last observation per computer in each five-minute bucket,
then sums those observations. Peak fleet values are **sampled estimates**, not a
sum of each computer's independent peak or an exact simultaneous count. Missing
buckets remain unknown. Phone-close paths emit a fresh presence count; alarms
observe after closing expired connections. The busiest individual computer's
observed phone count is compared with the existing eight-phone application limit.
No new relay storage, device identifier, or client instrumentation is introduced.

`/stats?view=usage` uses the same bearer and read-only boundary to query Cloudflare
GraphQL usage. The dashboard's monitor caches the result for 15 minutes across all
three connection windows. A usage API failure does not hide connection statistics,
and partial GraphQL errors or truncated results never turn into a zero-cost report.
The seven-day period ends at the preceding quarter hour. Account totals include
other projects because allowances are shared; only Shahi Worker names are returned.

The cost panel is a **30-day planning subtotal**, extrapolated from those seven days
on Workers Standard. It includes the base subscription, Worker invocations/CPU,
Durable Object requests/duration, and SQLite row operations with included allowances.
Hibernation events are conservatively counted at full request weight because the
API does not distinguish all billable messages from close/error callbacks. Incoming
non-hibernating WebSocket messages use the documented 20:1 ratio. Service invocations
can also overcount billable requests. Logs, stored data, Analytics Engine, other
products and taxes are excluded; this is neither an invoice nor a spending ceiling.
The optional budget comparison lives only in the open page and sends no email.
Rates and rounding were checked on 28 September 2026 against
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).
Recheck these sources before changing the calculation. Growth/retention, crashes,
feature usage and per-device reconnect recovery require separate instrumentation.

The independent `shahi-operations` Worker has no public route, `workers.dev`, or
preview URL. A cron runs every minute. It checks the public website, browser
app, signup API (without submitting an email), relay HTTP health, and a real
bidirectional relay path using a fresh synthetic box identity. It also checks
analytics availability. A private Durable Object retains only the latest check
and fixed set of incident states. The relay's protected `/ops/status` and
`POST /ops/check` expose the monitor through a service binding.

| Incident | Unhealthy sample |
|---|---|
| Public service / tunnel / analytics | Check fails or times out |
| Service latency | A successful check takes over 3 seconds |
| Signup delivery errors | At least 3 signup 5xx responses in 5 minutes |
| Relay internal errors | At least 5 in the preceding 5 minutes |
| Connection rejections | At least 100 and at least 20% of connection attempts in 5 minutes |
| Authentication failures | At least 50 box connections in 5 minutes that ended before authenticating: a wrong key, ten seconds without `auth`, leaving or an oversized control first, or a pending box closed for a newcomer (before the pre-release bug hunt's B107, only a wrong key counted) |
| Reconnect storm | At least 100 box disconnects in 5 minutes |

Three consecutive unhealthy samples send an incident email, two healthy
samples send recovery, and an ongoing incident is reminded hourly. Delivery
failures are logged/counted and retried on the next check. Delivery is at least
once: a timeout or crash after acceptance can duplicate an email. The recipient
is the existing verified Cloudflare budget-alert address, stored as a secret.
Budget alerts remain separate from availability alerts and are not a spending
cap. Account-wide Cloudflare or email outages can also affect this monitor;
an independent provider is needed for that failure mode. Check `checkedAt` when
using `/ops/status` — an old successful check is not evidence of current health.

Operator commands (the file must be mode 0600):

```sh
export SHAHI_OPERATIONS_SECRETS=/private/path/operations-secrets.json
bun operations/manage.ts status
bun operations/manage.ts stats
bun operations/manage.ts check
bun operations/manage.ts test-alert  # sends a clearly marked setup email
```

Provision relay secrets `STATS_TOKEN`, `CF_ACCOUNT_ID`, `CF_ANALYTICS_TOKEN`
(Account Analytics:Read, restricted to the relay account). Provision monitor
secrets `STATS_TOKEN` and `ALERT_TO`, deploy `operations/wrangler.toml`, then the
relay with its `OPERATIONS` service binding. Use Wrangler secret input; never
commit secrets. Keep the read-only analytics token separate from deploy access.

## Private owner dashboard

The operations dashboard at `https://admin.getshahi.dev/` has an overview and
`/statistics` page. It is for Shahi's infrastructure owner, separate from the
customer app and its paired computers. The overview shows recent service checks,
open incidents and relay activity. Statistics include traffic, handshake timings,
edge locations, refusal reasons, phone close codes and beta-form HTTP results.
Select the last hour, 24 hours or seven days; presence always uses the last ten
minutes and incident thresholds always use five minutes.

These counts are operational estimates, not unique people, installs or retention.
Analytics Engine may sample events. The presence estimate counts observed
computer identities and can include a computer that disconnected recently.
Traffic is emitted on alarms/close, so totals arrive with a delay. Empty traffic
or handshake aggregates can be unavailable rather than zero. A monitor sample
older than three minutes, a missing check or a failed query cannot appear as a
current healthy result. There is no billing estimate or historical uptime SLA.

The dashboard polls once a minute while visible. The private monitor coalesces
concurrent statistics reads and caches each of three allowed windows for one
minute. It does not persist a new copy of fleet analytics. Reads cannot trigger
checks, email alerts, or customer-agent actions. A query failure is displayed
independently from monitor status; refreshing never silently serves an expired
cached success. No new customer telemetry or browser analytics SDK is added.

Deploy the relay and operations Worker before the dashboard. The dashboard
Worker has only a private `OPERATIONS` service binding, with no analytics or
relay bearer token sent to the browser. It requires a Cloudflare Access
application protecting **this Worker only**, with an allow policy restricted to
the owner's identity. Never enable Access account-wide: that would gate the
public app and relay. Provision the application's audience as the dashboard's
`ACCESS_AUD` secret. The handler verifies Cloudflare's authenticated `ctx.access`
and its audience and requires a human email identity before serving any HTML,
JavaScript or data. Missing configuration, a removed Access policy, a forged
request header or a different Access app fails closed.

```sh
bun node_modules/wrangler/bin/wrangler.js deploy --config relay/wrangler.toml
bun node_modules/wrangler/bin/wrangler.js deploy --config operations/wrangler.toml
bun node_modules/wrangler/bin/wrangler.js deploy --config dashboard/wrangler.toml
# Configure the owner-only Access application, then enter its audience privately:
bun node_modules/wrangler/bin/wrangler.js secret put ACCESS_AUD --config dashboard/wrangler.toml
```

HTML/CSS/JavaScript are bundled text modules, intentionally not Workers Static
Assets: the assets router does not propagate `ctx.access`. See
[Cloudflare's Access context documentation](https://developers.cloudflare.com/workers/configuration/cloudflare-access/#ctxaccess-limitations).
All responses are `no-store`, deny framing and third-party scripts, and disable
automatic HTML transformation. No service worker or browser storage is used.
The Worker has no `workers.dev` or preview URL. Complete provisioning by checking
that an unsigned request cannot read `/`, `/app.js` or `/api/dashboard`, then
sign in as the owner and verify all three time ranges against live data.

`bun run test:dashboard` runs Chromium and iPhone-sized WebKit against an isolated
loopback fixture; it never connects to production. The fixture displays invented
counts, not production measurements. Authentication and cache regression tests
run in `bun run test`, telemetry SQL tests in `bun run test:relay`, and Worker
source is covered by `bun run typecheck`. CI also bundles the dashboard to catch
missing assets. Preview the fixture with `bun e2e/dashboard/server.ts` at
`http://127.0.0.1:7999/`; this test-only server has no production credentials.

## Concurrency verification

`bun relay/scripts/load.ts 1000` starts local workerd and creates 1,000 synthetic
boxes with 1,000 concurrent phones (2,000 sockets), exchanges 20,000 2 KiB round
trips, and reconnects every box/phone. It never connects to production or herdr.
The September 5, 2026 run passed in 60 seconds: p50 977 ms, p95 1,662 ms,
p99 1,989 ms on this development machine. An initial run sharing another local relay suite's harness timed out; the
reported run used its own harness and sent a hello immediately while opening
the fleet.

This is a local capacity/regression check, not a production SLA. Cloudflare
WAF and front-door connection limits (per IPv4 address or IPv6 /64), shared
office/VPN addresses, global latency,
long-lived workloads and regional failures require separate production-like
capacity tests. There are still eight phone links maximum per box. The paid
Workers plan does not raise application quotas. Updated clients/computers support 32 MiB relay uploads in bounded chunks; older
computers retain the 761 KiB file limit. SSH remains 32 MiB. The higher file cap
does not increase per-phone bandwidth. See the dated
[large-transfer review](large-relay-transfers-2026-09-20.md) for measured coverage.

The reliability transport is protocol 2. Refresh the hosted app and rebuild or
update native clients together with their sidecars; old clients are rejected
and counted as `relay.protocol_mismatch`. No native store release is implied by
deploying the hosted app.
