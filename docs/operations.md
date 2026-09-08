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

## Where things live

herdr gives the plugin two directories and keeps them apart from the checkout,
so an upgrade never touches your secrets or your data.

| what | where |
|---|---|
| the checkout | `$HERDR_PLUGIN_ROOT` — replaced on upgrade, never edit |
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

**Rebuild and restart after touching `web/`.** The sidecar serves `web/dist`,
so an unbuilt change is invisible.

## What healthy looks like

Startup prints the version, the address, and what it found:

```
herdr 0.8.2 (protocol 20) at /home/you/.config/herdr/herdr.sock
listening on http://127.0.0.1:7171
  11 workspaces, 47 panes, 14 agents (0 blocked)
  passcode required
  relay: connected
```

A protocol other than 20 prints a loud warning. herdr's schema is unversioned
for third parties, so a mismatch means something in `server/lib/herdr-schema.ts`
may now be wrong — regenerate with `bun run gen:types` and read the diff.

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

## Rotating the passcode

```sh
bun run server/scripts/init-secrets.ts --passcode <digits>
herdr plugin action invoke shahi.restart
```

Only the bcrypt hash is stored; the plaintext lives nowhere. The session secret
is left alone, so paired devices stay signed in. To revoke one phone instead,
use Settings in the app — revocation takes effect on its next request and on its
open socket.

Note that the passcode `4821` appears in this repository's early history, in a
script that hardcoded it as a default. Rotating is the clean fix if that matters
to you.

## Backing up

Back up the private `.env` and a consistent SQLite backup, including its relay identity and device credentials. The checkout regenerates from the plugin repository.

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

These are server-side operational metrics. The hosted client has no third-party
analytics SDK. Static responses send `Cache-Control: public, no-transform` to
prevent Cloudflare's automatic beacon injection, alongside the PWA's
`script-src 'self'` policy. Cloudflare documents this behavior in its
[Web Analytics setup guide](https://developers.cloudflare.com/web-analytics/get-started/).
Verify public HTML with a browser User-Agent: a plain curl request can receive
different injection behavior. Worker subrequests do not exercise that injection
path, so the availability monitor alone cannot establish its absence.

`GET https://relay.getshahi.dev/stats` requires a separate bearer admin token.
It returns event/close/refusal/region breakdowns, bytes and frame counts,
handshake mean/max, signup statuses and mean timings from `shahi_site`, a five-minute timeline, recent presence estimates and
five-minute alert counters. Authenticated synthetic probes are excluded from fleet summaries. Presence is approximate and traffic is delayed
until the next alarm/close. Missing query credentials return 503; query failure
returns 502 rather than an empty healthy dashboard. All admin replies are
`no-store`. Never put the bearer token in a URL, browser storage, or source code.

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
| Authentication failures | At least 50 in 5 minutes |
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

## Concurrency verification

`bun relay/scripts/load.ts 1000` starts local workerd and creates 1,000 synthetic
boxes with 1,000 concurrent phones (2,000 sockets), exchanges 20,000 2 KiB round
trips, and reconnects every box/phone. It never connects to production or herdr.
The September 5, 2026 run passed in 60 seconds: p50 977 ms, p95 1,662 ms,
p99 1,989 ms on this development machine. An initial run sharing another local relay suite's harness timed out; the
reported run used its own harness and sent a hello immediately while opening
the fleet.

This is a local capacity/regression check, not a production SLA. Cloudflare
WAF/per-IP connection limits, shared office/VPN addresses, global latency,
long-lived workloads and regional failures require separate production-like
capacity tests. There are still eight phone links maximum per box. The paid
Workers plan does not raise application quotas. Attachments remain limited to
roughly 761 KiB per relay file (765 KiB including its multipart body) or 32 MiB
through SSH/direct HTTP. A 100 MB relay attachment is rejected before reading
its bytes; supporting it requires a separate chunked-transfer feature.

The reliability transport is protocol 2. Refresh the hosted app and rebuild or
update native clients together with their sidecars; old clients are rejected
and counted as `relay.protocol_mismatch`. No native store release is implied by
deploying the hosted app.
