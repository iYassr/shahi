# The blind relay

How a phone reaches a box from anywhere with nothing opened and nothing
trusted in between. This is the "outbound-dialing blind relay" that
`connectivity.md` settles on, built as a Cloudflare Worker you deploy once
(`relay/`), a client in the sidecar that dials out to it, and a transport in
the app that speaks to the box *through* it. The relay forwards bytes it cannot
read; everything that matters happens end to end between phone and box.

This file is the protocol, version 1. The three parts are built separately and
meet here, so every byte on the wire is specified below and the shared shapes
live in `shared/src/relay.ts`. Change the protocol by changing this file and
that module together, and by bumping `RELAY_PROTOCOL`.

## Who is who

- **Box.** The machine running herdr and the sidecar. It has a permanent
  Ed25519 keypair, generated once and kept in the sidecar's SQLite (`identity.ts`).
  Its **`serverId`** is `base64url(sha256(publicKey))` — 43 characters that
  cannot be guessed and cannot be claimed by anyone without the private key.
  (This replaces the random UUID; a box that upgrades gets a new id and its
  phones pair again — there is no compatibility path, per CLAUDE.md.)
- **Relay.** One Worker, one Durable Object per `serverId`. It authenticates
  boxes (so nobody can sit on someone else's id) and forwards frames between a
  box and its phones. It never sees a key, a passcode, a request path or a byte
  of a terminal. What it does see, and Cloudflare with it: both ends' IP
  addresses; the `serverId` (in the box's URL, so in request analytics) and
  the box's public key; a presence timeline (the box pings every minute); each
  phone's `deviceId` or pairing-code hash, in the clear in its hello; how many
  phones a box has; and the size and timing of every frame. The default relay
  is `relay.getshahi.dev`, run by Shahi's author.
- **Phone.** Holds, per box, a `deviceId` and a 32-byte **device secret**
  handed to it at pairing, in the Keychain. Before pairing it holds only the
  32-byte **pairing secret** from the QR.

## What the relay does (relay ↔ box, relay ↔ phone)

Two WebSocket endpoints on the relay, both plain WSS with no relay-level
secrets for phones:

- `wss://<relay>/v1/box/<serverId>` — the box's persistent connection. On
  open the relay sends `{"t":"challenge","nonce":"<base64url 32 bytes>"}`. The
  box answers `{"t":"auth","pub":"<base64url 32>","sig":"<base64url 64>"}`
  where `sig` is Ed25519 over the UTF-8 bytes of
  `"shahi-relay-box-v1" + serverId + nonce`. The relay checks
  `base64url(sha256(pub)) == serverId` and the signature, then sends
  `{"t":"ready"}`. Anything else, or ten seconds of silence, closes with
  `4401`. A second box connection for the same id replaces the first (the old
  one is closed with `4409`): a restarted sidecar must not be locked out by
  its own zombie.
- `wss://<relay>/v1/phone/<serverId>` — a phone's connection. If no box is
  connected the relay closes it at once with `4404` ("box offline"); the app
  shows that in words. Otherwise the relay assigns a **link** number and tells
  the box `{"t":"open","link":n}`; when the phone goes it tells the box
  `{"t":"close","link":n}`; the box can end a link with the same message.

The relay cannot ping a box (a Durable Object cannot originate one), so the
box sends the text frame `ping` every sixty seconds once ready; the relay
answers `pong` without waking and closes a box silent for five minutes, whose
phones then see `4404`. Both words are plain text, not JSON, and are the only
text frames on a box socket that are not control messages. The pings only
prove the box can write, so the box also watches its read side, as the phone
does: if no frame — not even a `pong` — arrives within 150 seconds, it drops
the socket and redials, rather than sitting on a wedged connection no phone can
reach.

Data is binary frames. On the phone side a frame is the payload as is. On the
box side every data frame is `link(4 bytes, big-endian) ‖ payload`, so one box
socket carries every phone. Text frames are relay control only, as above.

Limits, enforced by the relay: payload ≤ 1 MiB, at most 8 phones per box,
at most 64 KiB/s sustained per phone with a burst of 1 MiB (a reader window is
~15 KB; a photo upload is the reason for the burst), and idle phone sockets
closed after 10 minutes without a frame. The relay keeps no history: a frame
that arrives while the box is disconnected is dropped and the phone's socket
is closed with `4404`, which is honest — the phone reconnects and asks again.

## What the box and phone do (end to end, opaque to the relay)

**Hello.** The first frame from the phone is a *binary* frame whose bytes are
this JSON — binary because the relay forwards only data frames and drops
text from phones (text is relay control). The box answers the same way: its
hello is the first data frame back. Nothing else on a link is unsealed.

```json
{"t":"hello","v":1,"pub":"<base64url X25519 ephemeral public key>",
 "auth":{"kind":"device","deviceId":"…"}}
```
or, before it has paired,
```json
{"t":"hello","v":1,"pub":"…","auth":{"kind":"pairing","id":"<base64url sha256(pairing secret)>"}}
```

The secret itself never travels: the box finds the shared secret by `deviceId`
(the device secret) or by the hash of a pairing code it minted and has not yet
seen claimed. The box answers `{"t":"hello","v":1,"pub":"<its ephemeral>"}`.
Both sides then derive a session exactly as `shared/src/e2e.ts` does —
`clientSession` on the phone, `serverSession` on the box — with the shared
secret as the pairing secret argument. A relay, or anyone, who does not hold
that secret derives different keys, and the first sealed frame fails to open;
the box closes the link with `4403`. An unknown `deviceId` or pairing id is
`4401`. Every frame after hello is a sealed message from `e2e.ts`
(`counter ‖ ciphertext`), each direction on its own key, counters never reused,
a replayed frame refused.

**Inside a sealed frame** is UTF-8 JSON, one of:

- `{"t":"req","id":n,"method":"GET","path":"/api/session","headers":{…},"body":null}`
  from the phone; `body` is base64url of the request bytes when there is one.
  `headers` carries `content-type` and `x-shahi-api`; the box adds the session.
- `{"t":"res","id":n,"status":200,"headers":{…},"body":"<base64url>"}` from
  the box, `headers` limited to `content-type`, `etag`, `cache-control`.
- `{"t":"ws","data":<SocketMessage>}` from the box — the same messages the
  `/ws` socket pushes (`session`, `frame`, `prompt`, `status`, `log_changed`,
  `ping`) — and `{"t":"ws","data":{"type":"watch","paneId":"…"}}` /
  `{"type":"unwatch"}` from the phone. One link is therefore both the request
  channel and the dashboard stream; the app opens exactly one.
- `{"t":"bye"}` from the box: the phone's session is gone — revoked in Settings,
  or expired — so it signs out and stops reconnecting, the mirror of a `/ws`
  close with `4001`. It has to be a sealed message rather than a close code
  because the relay flattens a box-driven close to `1000`, which the phone would
  retry; without it a revoked phone reconnected on a backoff loop forever, cut
  off but never told to sign out. Additive and unversioned: an older box never
  sends it, an older phone ignores an unknown `t`.

**Authentication inside the box.** A plaintext hello naming a device is not
authentication. The link must prove possession of its secret by sending a valid
sealed message within fifteen seconds of opening. Both clients immediately send
a sealed watch/unwatch after deriving device-session keys; a pairing client sends
its sealed metadata request. The deadline is cleared only by a successfully
opened message, never by the hello or outbound heartbeats. Before proof, the box
issues no session and attaches no stream. It rechecks device revocation at proof
time. Unproved links are closed so they cannot occupy all eight phone slots
indefinitely. Repeated connection floods can still disrupt availability.

After proof, a device link mints a session token bound to the device
id for the link and attaches it to every request it dispatches, so the sidecar's
HTTP layer — the gate, revocation on every request, the 426 check, the routes —
runs unchanged. Revoking the device closes its links. A link that opened with
`auth.kind == "pairing"` may call exactly two routes: `GET /api/meta`, so the
phone can check the `serverId` in the code against the box it reached before
it hands over the secret, and `POST /api/pair/claim`,
which consumes the code as today and now also answers
`{"ok":true,"deviceId":"…","deviceSecret":"<base64url 32>"}`; the phone stores
both and reconnects as a device. Any other path on a pairing link is `403`.

**Dispatch.** The box turns a `req` into an in-process `Request` for its own
handler (URL `http://relay.local` + path, the headers above plus the session
cookie) and turns the `Response` into a `res`. The Origin check is satisfied
(no Origin); the rate limiter sees no peer address and keys relay traffic as
`relay:<deviceId>`.

## Where the pieces live

- `relay/` — the Worker and its Durable Object, `wrangler.toml`, tests that
  run under `wrangler dev` with no account. Deploy: `cd relay && bunx wrangler
  deploy`. Anyone may run their own; the app takes the relay address from the
  pairing code.
- `server/lib/identity.ts` (the keypair and `serverId`), `server/lib/relay-client.ts`
  (dial out, authenticate, hold links, hello, seal/open, dispatch), started by
  `server/index.ts` when `RELAY_URL` is set. Pairing codes carry
  `relay` beside `endpoint` when the box has one.
- `mobile/src/lib/relay.ts` — the transport: one socket, hello, sealed
  request/response with ids, the dashboard stream folded into `SessionSocket`.
  `api.ts` routes through it whenever the stored connection is a relay one.

## What this deliberately does not do

- No relay-level auth for phones: a phone that knows a `serverId` can open a
  link and will be refused by the box at the first frame. The id is 256 bits
  of hash; the relay's per-phone quota bounds the cost of guessing anyway.
  Every such attempt does instantiate a Durable Object for the id it names.
  A *phone* with no box is refused with `refuse()`, which writes nothing and
  schedules nothing (2026-09-02 review, R7). A *box* connection, though, is
  accepted and challenged, and that schedules a ten-second auth-timeout alarm
  — one storage write per attempt (2026-09-02 pentest, L3). Both are bounded
  by Cloudflare's own limits and by the per-IP front-door limiter; neither
  accumulates, since an unauthenticated box is dropped at the timeout.
- No history, no store-and-forward, no direct WebRTC. The relay is a pipe.
- No protection of frame *sizes and timing*, addresses or identifiers from
  the relay. That is the metadata a blind pipe still sees; the list is under
  "Who is who".

## Operating the relay

The relay is `relay/`: a Worker, one Durable Object class (`RelayBox`, one
instance per `serverId`), and nothing else — no KV, no database, no secrets.
It supports Cloudflare's free plan. Sockets hibernate and the object can be
evicted between frames; request, alarm, storage, and telemetry usage still count
against the account's applicable limits. Verify the actual account plan and usage.

**Deploy.** Once, from a machine with a Cloudflare account:

```sh
cd relay
bunx wrangler login       # opens the browser; once per machine
bunx wrangler deploy      # prints the address it is reachable at
```

That address is the relay. Every later `bunx wrangler deploy` upgrades it in
place; connected boxes are dropped for a second and reconnect. There is
nothing to configure in the Worker itself — the `serverId` in the URL is all
it needs.

**Use a domain you own.** `wrangler.toml` here carries a `[[routes]]` entry
with `custom_domain = true`, which is how the shared relay answers on
`relay.getshahi.dev`. Two reasons to copy that rather than live on
`workers.dev`: the URL is a trust anchor baked into every install and pairing
code, and only a domain you own can be repointed at another host later; and
Cloudflare's WAF and rate-limiting rules apply to zones you own, so a rule on
`/v1/*` is not expressible for a `workers.dev` subdomain at all.

Both `workers_dev` and `preview_urls` are explicitly false. Only the owned
hostname is public, so alternate Worker addresses cannot bypass controls scoped
to that hostname. Update boxes to the canonical relay before deploying this
restriction. Devices paired to the retired `shahi-relay.yasserd99.workers.dev`
address need a fresh pairing; the address is stored with each pairing.

**Point a box at it.** The herdr plugin's service dials Shahi's relay unless
its `.env` has a `RELAY_URL` line — empty for direct-only, or your Worker's
address. By hand, the sidecar dials out when `RELAY_URL` is set:

```sh
RELAY_URL=https://relay.example.com   # what `wrangler deploy` prints; the box speaks wss to it
```

in the sidecar's environment (the plugin's `.env` is at `herdr plugin
config-dir shahi`; under the hand-made systemd unit it is
`~/.config/shahi/env`, see `operations.md`). Pairing codes minted after that carry the relay beside
the LAN endpoint, and the app prefers the relay because it works from
anywhere. Nothing on the box needs a port opened.

**Run one yourself.** Anyone may: the app takes the relay address from the
pairing code, so a box and its phones agree on whichever relay the box was
told about. The relay never holds a key, a passcode or a readable byte, so
running it for other people costs them nothing in trust beyond what a blind
pipe sees — frame sizes and timing.

**Run it locally, with no account:**

```sh
cd relay && bunx wrangler dev      # http://localhost:8787, workerd on this machine
bun run test:relay                 # starts and stops its own wrangler dev on 8787
```

`wrangler dev` runs the real runtime (workerd) with Durable Objects,
hibernation and alarms, which is why the test suite needs no mocks: it opens
sockets as a box and as phones and checks every close code in the table
above. A `wrangler dev` already on the port is used as is, so the suite can be
re-run against one left open.

**Liveness.** The Workers runtime cannot send WebSocket ping frames from a
Durable Object, so a dead box is detected the other way round: **a box sends
the text frame `ping` once a minute.** The runtime answers `pong` from
outside the object (`setWebSocketAutoResponse`), so a healthy idle box never
wakes it; an alarm every five minutes reads the timestamp of the last such
answer and closes any box not heard from in five minutes (code `1000`,
reason `silent`), which closes that box's phones with `4404`. A box that does
not ping is therefore dropped every five minutes: the sidecar's relay client
must ping. Phones may ping too and get the same `pong`, but nothing depends
on it — an idle phone is closed after the ten-minute limit regardless.

**What it logs.** Nothing about frames. Beyond wrangler's own request log,
the relay records one **Workers Analytics Engine** data point per lifecycle
event, and nothing else — it stays as blind here as on the wire.

## Observability

The relay is the one place with a fleet view, because it is your
infrastructure and already sees the metadata (who is connected, how a
connection ended, from where) while it reads not one byte of a session.
`relay/src/telemetry.ts` writes one Analytics Engine point per event to the
`shahi_relay` dataset. Recorded: the event kind, the `serverId` (a key hash,
not an identity), a close reason or refusal cause, a close code or live phone
count, and the Cloudflare colo. Never recorded: a request path, a frame body,
or a raw client IP (Cloudflare's own analytics and WAF hold per-IP data
transiently; the dataset does not).

**The schema** (Analytics Engine columns): `blob1` kind
(`box_auth`, `box_gone`, `phone_open`, `phone_close`, `refused`, `connect`,
`rate_limited`), `blob2` serverId, `blob3` detail, `blob4` colo, `double1`
value (a close code, a phone count, or 1), `index1` kind.

**Queries.** Run these in the dashboard (Workers → the Worker →
your dataset → the SQL query box), or via the SQL API. Each sums
`_sample_interval` so counts stay right under Analytics Engine's sampling.

```sql
-- boxes seen online in the last 10 minutes (a live-ish estimate)
SELECT COUNT(DISTINCT blob2) FROM shahi_relay
WHERE blob1 = 'box_auth' AND timestamp > NOW() - INTERVAL '10' MINUTE;

-- what is happening, by event, in the last hour
SELECT blob1 AS kind, SUM(_sample_interval) AS n FROM shahi_relay
WHERE timestamp > NOW() - INTERVAL '1' HOUR GROUP BY kind ORDER BY n DESC;

-- why links are closing (watch for a spike in one code)
SELECT double1 AS close_code, SUM(_sample_interval) AS n FROM shahi_relay
WHERE blob1 = 'phone_close' AND timestamp > NOW() - INTERVAL '1' HOUR
GROUP BY close_code ORDER BY n DESC;

-- refusals, by cause (box offline vs too many phones vs rate)
SELECT blob3 AS reason, SUM(_sample_interval) AS n FROM shahi_relay
WHERE blob1 = 'refused' AND timestamp > NOW() - INTERVAL '1' HOUR
GROUP BY reason ORDER BY n DESC;

-- a box that reconnects too often is failing; find it
SELECT blob2 AS serverId, SUM(_sample_interval) AS reconnects FROM shahi_relay
WHERE blob1 = 'box_auth' AND timestamp > NOW() - INTERVAL '1' HOUR
GROUP BY serverId HAVING reconnects > 20 ORDER BY reconnects DESC;
```

**A live `/stats` endpoint** (optional). `GET /stats` returns those figures as
JSON, gated so it discloses nothing by default. Set three secrets to turn it
on and let it read:

```sh
cd relay
bunx wrangler secret put STATS_TOKEN        # a bearer the caller must send
bunx wrangler secret put CF_ACCOUNT_ID      # your account id
bunx wrangler secret put CF_ANALYTICS_TOKEN # an API token with Account Analytics Read
```

Then `curl -H "Authorization: Bearer <STATS_TOKEN>" https://<relay>/stats`.
With no `STATS_TOKEN` the endpoint is a 404; with it but no query credentials
it is a 503 that says so.

**Abuse limits and alerts.** The `CONNECT_LIMIT` binding allows thirty
connection attempts per IP per ten seconds at each edge location. It is
eventually consistent and is not a global traffic or billing ceiling; see
[Cloudflare's locality and accuracy documentation](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
Retiring alternate hostnames does not itself configure a WAF rule. Review the
actual account's limits and set these controls in the Cloudflare dashboard:

- **Error/availability monitoring** for `shahi-relay` through monitoring available
  to the account. A Workers-specific error alert was not offered in the checked
  account's Notifications catalog on 5 September 2026.
- A **spend / usage** notification — so an abuse spike on the paid plan
  arrives as a message, not a surprise bill.
- Optionally a **WAF rate-limit rule** on `/v1/*` keyed on client IP, a second
  limit ahead of Worker and Durable Object execution. Distributed floods remain
  an availability risk even with per-IP limits.

What the relay still cannot tell you is a box that is *up but wedged* (herdr
down behind a healthy socket); that needs a status byte in the box's
ping, which lives in the sidecar, not here — a deliberate next step.

**Close codes, as sent by this relay:**

| code   | reason              | to    | when                                              |
| ------ | ------------------- | ----- | ------------------------------------------------- |
| `4401` | `unauthorized`      | box   | bad `auth`, or anything that is not one           |
| `4401` | `auth timeout`      | box   | ten seconds after the challenge with no `auth`    |
| `4409` | `replaced`          | box   | another connection proved the same key            |
| `1000` | `silent`            | box   | five minutes without a frame or a `ping`          |
| `4429` | `frame too large`   | box   | a data frame over 1 MiB (its phones get `4404`)   |
| `4404` | `box offline`       | phone | no ready box on connect, on send, or box went away |
| `4429` | `too many phones`   | phone | the ninth phone                                   |
| `4429` | `frame too large`   | phone | a frame over 1 MiB                                |
| `4429` | `rate`              | phone | the token bucket (64 KiB/s, 1 MiB burst) ran dry   |
| `1000` | `idle`              | phone | ten minutes without a frame either way            |
| `1000` | `closed by box`     | phone | the box sent `close` for the link                 |

Telemetry events are retained by Analytics Engine for three months. The stable
server identifier can correlate a box's events. The public policy documents
the fields and retention in `docs/privacy-policy.md`. Omitting `STATS_TOKEN`
hides `/stats` but does not stop collection; remove the `TELEMETRY` binding to
stop Shahi event collection on a self-hosted relay.
