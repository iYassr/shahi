# Stream report: auth flow — QR pairing (`stream/auth-pairing`)

## What changed

**Contract** — `shared/src/index.ts` (additive): `PairingPayload`, `PairingCode`,
`PairedDevice`, `DeviceList`; all four added to `shared/src/contract.test.ts`'s
guard list. `SHAHI_API_VERSION` not bumped: additions only.

**Server**
- `server/lib/pairing.ts` (new): `Pairing` (in-memory codes: 32 random bytes
  base64url, single use, 10-minute TTL, pruned), `pairingUrl()` (the
  `shahi://pair#…` fragment), `Devices` (SQLite `devices` table: id, name,
  created_at, last_seen_at, revoked_at; create/list/isActive/touch/revoke).
- `server/lib/auth.ts`: tokens are now `expiry[.deviceId].signature`.
  `issue(now, deviceId)` binds a session to a device; new `identify()` returns
  `{ deviceId }` or null; `verifyToken` is `identify() !== null`. New
  `AuthOptions.deviceActive` is consulted on every check of a device token, so
  revocation is immediate. Passcode tokens are unchanged in shape and every
  existing auth test still passes.
- `server/lib/http.ts`: `POST /api/pair/claim` (unauthenticated, through the
  existing `LoginThrottle`), `POST /api/pair` (authenticated — mints; this is
  how the script gets a code into the server's memory), `GET /api/devices`,
  `DELETE /api/devices/:id` (also closes the revoked device's open WebSocket).
- `server/scripts/pair.ts` (new): signs a session from `.env`'s
  `SESSION_SECRET`, asks the running server for a code, picks/probes the
  endpoint, prints the QR (`qrcode`, terminal renderer) and the text.
- `server/lib/pairing.test.ts` (new, 13 tests): mint, claim once, second claim
  fails, expiry, URL shape, devices CRUD, last-seen granularity, device id
  inside the signature, revoke rejects on the next check, gate-off behaviour.

**Mobile**
- `mobile/src/lib/pairing.ts` (+ test): `parsePairingUrl`, hand-parsed, null
  for anything not a complete Shahi code.
- `mobile/src/lib/api.ts` (+ tests): `claimPairing`, `devices`, `revokeDevice`.
- `mobile/src/components/scanner.tsx` (new): `expo-camera` `CameraView`,
  QR only, permission handling, one scan handled once, re-arms on a foreign QR.
- `mobile/src/screens/connect.tsx`: **Scan a code** above the typed forms;
  scan → parse → `connection.baseUrl = endpoint` → `api.meta()` → serverId must
  match → `claimPairing(secret, Device.deviceName ?? "iPhone")` → `onConnected()`
  (so `signIn` stores exactly what it always stored). Intro step 2 mentions the
  code.
- `mobile/src/components/paired-devices.tsx` (+ 5 tests) and
  `mobile/src/screens/settings.tsx`: **Paired devices** section — list, "this
  phone" marker, paired/seen ages, Revoke with `Alert` confirmation; revoking
  this phone is labelled "Sign out" and calls `signOut()` + `/connect`. Says
  plainly that passcode sign-ins are not devices.
- `mobile/app.json`: `expo-camera` plugin with a camera usage string, no
  microphone string, no `RECORD_AUDIO`.
- `e2e/stub/server.ts`: `/api/pair/claim` (fixed secret `stub-pair`),
  `/api/pair`, `/api/devices`, `DELETE /api/devices/:id` — so Settings, which
  now fetches the device list, keeps working in the Maestro flows.

**Docs** — `docs/pairing.md` (new).

**Dependencies** — `qrcode` (+ `@types/qrcode`) for the server: no QR encoder
existed in the tree; `qrcode` is the maintained one with types, and its
terminal renderer is exactly the script's need. `expo-camera ~57.0.3`
(SDK 57's bundled version) for the phone.

## Verified

- `bun run typecheck` — green (shared, server, web, mobile).
- `bun test shared/src server` — 332 pass, 0 fail (the known `agents.test.ts`
  spawn fault did not trip on this run).
- `bun run test:mobile` — 16 suites, 110 tests, all pass (14 existing + the
  pairing parser + paired-devices suites; api.test gained 3).
- **End to end over HTTP**, with the real `createServer` and faked herdr deps
  (scratch script, not committed): mint needs a session; wrong secret 401;
  claim 200 with device + cookie; same secret refused; `/api/devices` names the
  device for its own session and null for a passcode session; revoke 200, again
  404; the revoked phone's *next* request 401 while the passcode session keeps
  working. 12/12.
- **`pair.ts` itself**, against that fake server: prints a QR and the text, the
  printed code claims 200.

## Not verified

- **Nothing on a phone.** The scanner was written against the SDK 57 camera
  docs and typechecks, but the simulator has no camera and Expo says barcode
  scanning does not work there. First real scan is the proof.
- The live suite (`herdr-live.test.ts`) was not run (no herdr here, and the
  ground rules forbid touching one). It has no assertions about these routes.
- Maestro flows were not run (forbidden here). `settings.yaml` should be
  unaffected: the stub answers `/api/devices` and the flow's assertions
  (`localhost:7272`, `protocol 19`, "Sign out") are untouched.

## Deviations from the design, with reasons

- **How the script mints.** The design says the script mints the token, but a
  script cannot write into the server process's memory, so the server mints
  via an authenticated `POST /api/pair` and the script calls it with a session
  it signs from `.env`. Same trust set (whoever reads `.env` owns the server);
  and the route is what a future "pair another phone" button would use.
- **`DELETE /api/devices/:id` also closes that device's WebSocket** — "loses
  access immediately" would otherwise leave a live dashboard stream running.
  This added a `deviceId` field to `SocketData`, set in the `/ws` upgrade block.
- **`last_seen_at` moves at most once a minute**, not per request.
- **Microphone permission is explicitly off** in the camera plugin (scanning
  needs none; the plugin adds one by default).

## Changes outside my ownership (all small, all necessary)

- `server/index.ts`: constructs `Devices`/`Pairing`, passes `deviceActive` to
  `Auth`, passes both to `createServer`, one startup line (device count + how
  to pair).
- `server/lib/http.ts` beyond the route blocks: imports, `HttpDeps` gains
  `pairing`/`devices`, `SocketData.deviceId`, the `/ws` upgrade's data literal,
  and `authorized()` now goes through `identify()` and touches the device. The
  gate had to know about devices for revocation to be immediate.
- `server/package.json`, `mobile/package.json`, `bun.lock`: the two
  dependencies above.

## For the conductor

- **`npx expo prebuild --platform ios` before the next native build.**
  `expo-camera` is a native module with a config plugin; `run:ios` alone does
  not re-read `app.json` once `ios/` exists (`docs/on-a-mac.md`). Not run here.
- After merging, `bun install` (lockfile changed) and restart the server; the
  `devices` table is created on first start.
- `install.sh` still prints address + passcode only; printing a code from the
  installer is the obvious follow-up and was left alone as shared ground.
