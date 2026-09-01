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
  of a terminal.
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

**Hello.** The first frame from the phone is text:

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

**Authentication inside the box.** A link that opened with `auth.kind ==
"device"` *is* that device: the box mints a session token bound to the device
id for the link and attaches it to every request it dispatches, so the sidecar's
HTTP layer — the gate, revocation on every request, the 426 check, the routes —
runs unchanged. Revoking the device closes its links. A link that opened with
`auth.kind == "pairing"` may call exactly one route, `POST /api/pair/claim`,
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
- No history, no store-and-forward, no direct WebRTC. The relay is a pipe.
- No protection of frame *sizes and timing* from the relay. That is the
  metadata a blind pipe still sees.
