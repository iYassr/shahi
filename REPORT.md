# Stream: relay phone side — `stream/relay-phone`

The app talks to a box through a blind relay when the pairing code names one.
Nothing above `api.ts` changed: the same `request()`, the same `SessionSocket`
callbacks, carried inside sealed frames over one WebSocket.

## What changed

New:

- `mobile/src/lib/relay.ts` — the transport. `RelayLink`: one socket to
  `<relay>/v1/phone/<serverId>`, the hello with a fresh `expo-crypto` key,
  `clientSession` on the box's hello, sealed `req`/`res` matched by id with the
  caller's timeout, `ws` frames fanned out to subscribers, watch/unwatch, the
  same backoff and 70s watchdog as `/ws`, close codes in words. Never resends
  a request. `relayLink(target)` is the one link the requests and the socket
  share; `closeRelay()` ends it on sign-out. `deviceTarget` / `pairingTarget`
  build the two kinds of target; `toBase64Url` / `fromBase64Url` are the
  codec (Hermes has no `atob`).
- `mobile/src/lib/errors.ts` — `UnauthorizedError`, `IncompatibleServerError`,
  `UnreachableError` and `hostOf`, moved out of `api.ts` so the transport can
  throw them without a cycle. `api.ts` re-exports them; no importer changed.
  `UnreachableReason` gains `"box"` (4404) and `"relay"` (4429).
- `mobile/src/lib/relay.test.ts` (27 tests), `mobile/src/lib/session.test.tsx` (1).

Changed:

- `mobile/src/lib/api.ts` — `connection.relay: RelayTarget | null`; one
  `dispatch()` decides HTTP vs relay for `request`, `meta`, `login`,
  `claimPairing`, `readFile`, `upload`. New `api.claimRelayPairing` returns
  `ClaimResult`. `readFile` hands an image back as a `data:` URL over the
  relay (no URL an `Image` could fetch). `upload` frames the multipart body
  by hand over the relay (`fetch(file.uri).arrayBuffer()` reads the file).
  `SessionSocket` in relay mode subscribes to the shared link instead of
  opening its own; 4401/4403 reach `onExpired` like a 4001 does.
- `mobile/src/lib/session.tsx` — third stored kind
  `{ kind: "relay", relay, serverId, deviceId, deviceSecret }`; restore points
  `connection` at the device target (the first request opens the link);
  `signInRelay`; sign-out clears the target and closes the link. `server` is
  `relay://<host>`, which Settings and Unreachable show.
- `mobile/src/screens/connect.tsx` — scan path: with `payload.relay`, open a
  pairing-mode link, `GET /api/meta` through it and refuse on a `serverId`
  mismatch, `POST /api/pair/claim`, hand the identity to `signInRelay`. A
  refused link (4401) during pairing is worded as an invalid code, not as a
  lost pairing. Without `relay`, the HTTP path is unchanged.
- `mobile/src/lib/pairing.ts` — parses `relay` (must be an http(s) base URL
  if present; a malformed one makes the whole code invalid rather than
  silently falling back to the endpoint).
- `mobile/src/app/connect.tsx` — passes `signInRelay` to the screen.
- `mobile/package.json` — `expo-crypto ~57.0.2` (SDK 57's pin) and
  `@noble/hashes` as dependencies; Jest `transformIgnorePatterns` extended
  with `@noble`, which ships ESM only and otherwise fails every suite that
  reaches `e2e.ts`. `bun.lock` updated accordingly.
- `mobile/jest.setup.ts` — `expo-crypto` mocked with Node's CSPRNG.

`e2e.ts` is imported by relative path (`../../../shared/src/e2e`): the shared
package's `exports` map exposes only its index, and `e2e.ts` is not
re-exported there. Metro watches the workspace root, so it resolves at
runtime; Jest and tsc are proven.

## Verified

- `bun run typecheck` — green (all four projects, tests included).
- `bun run test:mobile` — 19 suites, 152 tests, green (was 17 / 121).
- `bun test shared/src server web/src` — 392 pass, 0 fail.

What the new tests prove, each with the real `e2e.ts` on both ends (a fake
box derives `serverSession` and opens the phone's frames):

- hello framing (`v: 1`, 32-byte key, device / pairing auth), the same keys
  derived on both ends, a fresh ephemeral key per connection, the path never
  in the clear;
- two requests in flight matched by id out of order; a request made while
  the link is down waits and goes out once; a request in flight when the link
  drops is rejected and **not** resent after the reconnect; timeouts in words;
- a 426 body over the relay is still `IncompatibleServerError`; a 401 still
  `UnauthorizedError`; the `x-shahi-api` header rides in the sealed headers;
- 4404 → `UnreachableError("box")` with the box-offline words, retried;
  4429 → `"relay"`; 4403 and 4401 → `UnauthorizedError`, `onExpired`, no retry;
  a box whose frames do not open with this phone's key → the same sign-out;
- watch/unwatch as sealed `ws` frames, the watch repeated after a reconnect;
  the box's stream reaches `onMessage`, the ping does not; the socket and the
  requests share one link;
- an image over the relay becomes a data URL; text is text; an upload is a
  multipart body with the file's bytes;
- pairing: the hello carries `base64url(sha256(secret bytes))` and never the
  secret; the claim answers a `ClaimResult`; a spent code is worded, not a
  sign-out; a malformed secret is refused before a socket opens; a new target
  retires the old link;
- restore: a stored relay entry comes up connected as `dev-1` through the
  relay, `server` reads `relay://relay.example.dev`, the session read goes
  sealed through the link and lands in the mirror.

## Not verified

- Nothing has run on a device or simulator, or against the real relay and the
  real box client (the other two streams). React Native's `WebSocket`
  (`binaryType = "arraybuffer"`, `send(Uint8Array)`) and `fetch(file://)`
  were checked against RN 0.86's sources, not run.
- `expo-crypto` is a native module. **The conductor must run `expo prebuild`
  (or `pod install` under `mobile/ios`) before the next iOS build**, or
  `getRandomBytes` throws at the first hello. `mobile/ios/` was not touched.

## Integration points to check against the box stream

These are decisions the protocol leaves to both ends; each is one line to
change here if the box chose otherwise.

1. **Pairing id hashes the secret's bytes.** `id = base64url(sha256(bytes))`
   where `bytes = base64url-decode(QR secret)` — the 32 bytes `e2e.ts` keys
   from — not the base64url string. The same bytes are the e2e pairing secret.
2. **`GET /api/meta` is sent on a pairing link before the claim** (the brief
   asks for the `serverId` check "same rule as today"). `docs/relay.md` says a
   pairing link "may call exactly one route". If the box answers 403 to meta on
   a pairing link, either the box allows `GET /api/meta` there or the check
   here is dropped; the relay URL already names the `serverId` the phone dials.
3. **Claim over the relay** is expected to answer `{ ok, deviceId, deviceSecret }`
   at the top level with status 200, `deviceSecret` being base64url of 32 bytes.
4. **Uploads** arrive as `multipart/form-data; boundary=…` with one `file`
   part; the box's `Request.formData()` must accept that (the HTTP route's
   does).
5. **Silence.** The link's watchdog closes after 70s without a frame, so the
   box must send `{"t":"ws","data":{"type":"ping",…}}` on every link as `/ws`
   does.
6. **Frame limit.** The relay caps a payload at 1 MiB; base64url inflates a
   body by 4/3, so a file over ~768 KB cannot travel in either direction
   (`readFile` of a large image, or a photo upload). This is the protocol's
   limit, not something the phone can work around; a chunked body is a
   protocol change. Worth knowing before the first photo is sent through.

## Outside my ownership

- `mobile/src/app/connect.tsx` — one prop wired (`signInRelay`).
- `mobile/jest.setup.ts` — the `expo-crypto` mock.
- `mobile/package.json` and `bun.lock` — two dependencies and the Jest
  transform list.
- `mobile/src/lib/errors.ts` — new; the error classes extracted from `api.ts`.
- No change to `agents.tsx`: "Can't reach your server" over "relay://host"
  with the box-offline message reads correctly without a new title.
