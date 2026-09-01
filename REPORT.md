# Stream report: relay box side (`stream/relay-box`)

The sidecar dials out to a blind relay and serves phones through it, end to
end encrypted, with the HTTP layer unchanged behind an in-process entry
point. Three commits on top of `72938a0`.

## What changed

**Identity** — `server/lib/identity.ts` (+ `identity.test.ts`)
- Ed25519 seed kept in `meta` as `identity_seed` (base64url);
  `serverId = base64url(sha256(publicKey))`; `sign(bytes)` for the relay
  challenge; `fromSeed` / `serverIdFor` exported for tests and the relay.
- **No migration from the UUID.** A box that upgrades gets a new id and its
  phones pair again. The old `server_id` row in `meta` is left alone and
  never read. Said in `docs/pairing.md` under "What the code is".

**Device secrets and pairing index** — `server/lib/pairing.ts` (+ test)
- `devices` table gains `secret BLOB NOT NULL`; `Devices.create` returns
  `{ device, secret }` (32 raw bytes); `Devices.secret(id)` answers only for
  active devices.
- `Pairing` keeps a second map, hash → secret; `secretByHash(id)` finds an
  outstanding code by `base64url(sha256(secret bytes))` without consuming it.
- `pairingUrl` adds `relay=` when the payload has one.

**Config** — `server/lib/config.ts` (+ test): `RELAY_URL` → `relayUrl`,
validated as http(s) at load, trailing slash stripped.

**HTTP layer** — `server/lib/http.ts` (+ test)
- `createServer` now returns `ShahiServer { port, stop, dispatch, attach,
  detach, receive }`. `dispatch(req, rateKey)` runs the same `handle` the
  port serves, uncompressed. `attach/detach/receive` are what the `/ws`
  `open/close/message` handlers now call, so a relay link and a socket go
  through one path.
- `StreamClient { data, send(payload), close(code, reason) }` is the
  interface both implement; `clients` is a `Set<StreamClient>`. Broadcasts,
  frame pushes, revocation closes and the heartbeat's re-check are unchanged
  and reach links for free.
- `Arrival { rateKey, upgrade }` is the explicit seam the brief asked for:
  the port passes `clientAddress(...)`, a link passes `relay:<deviceId>`
  (or `relay:pair:<hash>` before it has a device).
- `POST /api/pair/claim` answers `ClaimResult` additively:
  `{ ok, deviceId, deviceSecret, device }` plus the cookie as before.

**Relay client** — `server/lib/relay-client.ts` (+ `relay-client.test.ts`)
- Connects to `${RELAY_URL}/v1/box/${serverId}` over ws(s), answers the
  challenge, backs off 500ms → 30s forever, redials after 10s without
  `ready`. Logs connection state and link open/close only.
- Links: hello parsed strictly (never guessed), secret by device id or by
  pairing hash, ephemeral from `crypto.getRandomValues`, `BoxHello`,
  `serverSession`. Unknown hello or a frame that does not open (wrong
  secret, replay, tamper) ends the link with `{"t":"close"}` to the relay.
- `req` → `Request` for `http://relay.local<path>` with the phone's headers
  minus `cookie`/`origin`/`host`/`x-forwarded-*`, plus the link's own
  session cookie (minted once per device link via `Auth.issue`). Concurrent,
  answered by id. Pairing links: only `POST /api/pair/claim`, else 403.
  Responses carry only `content-type`/`etag`/`cache-control`; a body too big
  for one relay frame is answered 413 instead of being dropped by the relay.
- Device links are `attach`ed as `StreamClient`s; `ws` `watch`/`unwatch`
  go to `receive`; pushes go out as `{"t":"ws","data":…}` sealed.

**Wiring** — `server/index.ts` starts `RelayClient` when `relayUrl` is set,
stops it on signal, and the startup lines say `relay dialling <url> as <id>`
or `relay none (RELAY_URL not set); reachable directly only`.
`server/scripts/pair.ts`: one field, `relay`, when `config.relayUrl` is set.

**Docs** — `docs/pairing.md`: the new id derivation and the no-migration
note, the `relay` field, the `secret` column and `ClaimResult`.

## Verified

- `bun run typecheck` green (all four projects).
- `bun test shared/src server`: 379 pass, 25 skip (the live suites), 0 fail.
  Baseline before the change was 357 pass; 22 new tests.
- `bun run test:mobile`: 17 suites, 121 tests, pass (nothing in `mobile/`
  was touched; run because `shared/package.json` changed).
- `relay-client.test.ts` proves, against a fake relay (Bun WebSocket server
  that verifies Ed25519 signatures and numbers links) and a fake phone
  speaking `e2e.ts`, around the real `createServer`: box auth good / forged
  signature (4401, keeps retrying, never ready) / silent relay (redial after
  the timeout); pairing link claims and gets `ClaimResult` sealed, then
  returns as the device and fetches `/api/session` with three concurrent
  requests answered by id and the 426 gate working over the link; forged
  `cookie`/`origin`/`x-forwarded-for` ignored; unknown device and unknown
  pairing hash closed at hello; wrong secret closed at the first sealed
  frame with nothing answered; a replayed frame closes the link; `watch`
  produces a `frame` push and `unwatch` works; revoking the device closes
  the link and refuses its next hello; the relay dropping the box closes
  phones with 4404 and the box redials and serves again.
- `http.test.ts`: claim answers id + secret in the body beside the cookie.

## Not verified

- Against the real Worker in `relay/` (another stream) — the fake relay here
  is the spec reduced to what the box needs. Anything the Worker does
  differently from `docs/relay.md` will show up when the two meet.
- `log_changed` over a link is not exercised (it needs a transcript file on
  disk); the push path is the same `ws.send` the `frame` test proves.
- Nothing was run against a herdr session, live or named.

## Outside my ownership (small, deliberate)

- `server/package.json`: declared `@noble/curves` and `@noble/hashes` as
  dependencies (they were already installed via `shared`; the server now
  imports them directly). `bun.lock` updated accordingly.
- `shared/package.json`: added the subpath export `"./e2e": "./src/e2e.ts"`.
  `e2e.ts` itself is untouched. Rationale: re-exporting it from `index.ts`
  would pull the noble libraries into the web bundle through the index;
  a subpath keeps it opt-in. The phone stream can import
  `@shahi/shared/e2e` the same way.
- `server/lib/http.test.ts`: `relayUrl: null` in its `Config`, plus one new
  test. `server/lib/config.test.ts`, `pairing.test.ts`: updated for the new
  shapes.
- `docs/pairing.md`: the paragraphs named above.

## For the conductor to land it

- **The existing install's `devices` table has no `secret` column.**
  `CREATE TABLE IF NOT EXISTS` will not add it and the next claim would fail
  on the INSERT. Every phone must re-pair anyway (new `serverId`), so on the
  one installation that exists: stop the service, `sqlite3
  ~/.local/share/shahi/shahi.sqlite 'DROP TABLE devices'`, start it. No code
  was added for this, per the no-migrations rule; it is a one-off by hand
  like the rename was.
- Set `RELAY_URL=https://<worker>` in `.env` once the Worker is deployed;
  `pair.ts` then prints codes with `relay=`.
- The phone stream needs: `ClaimResult` from the claim body (`deviceId`,
  `deviceSecret`), the `relay` field of the code, and to hash the pairing
  secret's *bytes* (base64url-decoded) for the pairing hello.

## Notes for review

- A device link receives the dashboard push (`session`) at hello, before its
  first sealed frame proves it holds the secret — exactly as `/ws open` does.
  It is sealed under keys only the secret holder can derive, so a stranger
  who knows a device id gets ciphertext and then a close. Cost is one 18KB
  frame per guessed id, bounded by the relay's per-phone quota.
- `Auth.issue` tokens for links use the configured `sessionTtlMs`; the
  heartbeat re-check closes an expired link the same way it closes a socket,
  and the phone reconnects with a fresh hello.
