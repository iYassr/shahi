# Stream report: relay worker (`stream/relay-worker`)

## What changed

New workspace package `relay/`, the blind relay from `docs/relay.md`:

- `relay/src/index.ts` — the Worker: routes `/v1/box/:serverId` and
  `/v1/phone/:serverId` to the Durable Object named after the id. Malformed
  id → 400, no `Upgrade: websocket` → 426, anything else → 404.
- `relay/src/box.ts` — `RelayBox`, one Durable Object per `serverId`:
  challenge/auth/ready with Ed25519 + SHA-256 through WebCrypto (the Worker
  bundles no cryptography; `@noble/*` is used only by the tests to sign),
  `4401` on a bad or missing auth and after `boxAuthTimeoutMs`, `4409`
  replacement **on auth, not on connect** (an unauthenticated connection
  cannot knock the real box off — tested), links never reused within a box
  connection, 4-byte big-endian link prefix on the box side, phone text
  frames dropped, and every limit in `RELAY_LIMITS` as a close code. All
  state lives on socket attachments; every socket is accepted through the
  hibernation API; nothing is written to storage and nothing about a frame
  is logged.
- `relay/src/route.ts` — the path regex both files share.
- `relay/wrangler.toml`, `relay/tsconfig.json`, `relay/test/tsconfig.json`,
  `relay/package.json` (wrangler 4.128, `@cloudflare/workers-types`),
  `relay/.gitignore` (wrangler's `.wrangler/` state dir).
- `relay/test/harness.ts` + `relay/test/relay.test.ts` — 21 tests against a
  `wrangler dev` the suite starts on 8787 and stops in `afterAll` (a relay
  already on the port is reused, for iterating).
- `docs/relay.md` — "Operating the relay" appended: deploy, custom domain,
  pointing a box at it, running locally, the liveness rule, and a table of
  every close code and reason this relay sends.
- Root `package.json`: `relay` added to `workspaces`; `typecheck` now also
  runs `tsc -p relay` and `tsc -p relay/test`; new script `test:relay`.
  `bun.lock` updated accordingly.

## Verified, and how

- `bun run typecheck` — green (all six projects).
- `bun run test:relay` — 21 pass, 0 fail, ~12s, run three times in a row
  with the suite spawning its own `wrangler dev`, plus once per test in
  isolation. Covers: bad serverId → 400; unknown path → 404; no box → 4404;
  auth success; both auth failure modes (wrong key for the id, right key
  with a bad signature) plus a non-auth first frame; the 10s auth timeout
  (proves the alarm path works under workerd); second box → 4409 and its
  phones → 4404; unauthenticated pretender cannot displace the box; round
  trip with link prefix both ways; two phones, distinct links, no
  cross-talk; phone leaving → `close` to the box, link not reused; box
  `close` → phone 1000 and the box not told again; ninth phone → 4429 and
  room again after one leaves; >1 MiB → 4429 "frame too large" and the box
  told; burst spent once then 4429 "rate"; phone text frame dropped and the
  link still up; box disconnect → phones 4404; box frame for an unknown link
  dropped; `ping`→`pong` on both sides without reaching the other.
- `bun test shared/src server web/src` — unchanged, green.

## Not verified

- **Never deployed to Cloudflare.** No account was used, per the brief.
  `wrangler deploy` is the documented one command; the config is the
  standard SQLite-backed DO layout the free plan requires.
- **The five-minute silence reaper and the ten-minute phone idle close** are
  not exercised by a test (they would take minutes). The same alarm path is
  proven by the 10-second auth timeout test.
- Real Cloudflare may behave differently from local workerd in one respect
  worth watching: the "Network connection lost" uncaught error that a plain
  `accept()` + immediate `close()` produced locally. Refusals now go through
  `acceptWebSocket`, which is clean locally.

## Decisions the conductor should know about

- **Box liveness is box-originated ping, not DO-originated.** The Workers
  runtime has no API to send a WebSocket ping frame from a Durable Object,
  so the brief's "pinged by the DO" is not possible as stated. Instead: the
  box sends the text frame `ping` at least once a minute; the runtime answers
  `pong` via `setWebSocketAutoResponse` without waking the object; an alarm
  every `BOX_SILENCE_MS` (5 min) reads `getWebSocketAutoResponseTimestamp`
  and closes a box silent for 5 minutes (1000 "silent"), dropping its phones
  with 4404. **This is a requirement on `server/lib/relay-client.ts`
  (the relay-client stream): send `"ping"` every 60s on the box socket, or
  the box is dropped every five minutes.** Documented in `docs/relay.md`
  under "Operating the relay". It is one `setInterval` on the client.
- **An oversized frame from the box closes the box** (4429), not just the
  link: the box has proven its key, so an oversized frame is a bug on its
  side, and a loud failure beats one silently starved phone.
- **Phone idle counts frames in either direction.** A phone that only
  listens to a pushed dashboard stream is not idle.
- **WebCrypto over `@noble/*` in the Worker.** Ed25519 verify and SHA-256
  are native in workerd; the Worker has zero runtime dependencies and
  bundles only `shared/src/relay.ts` (constants) via a tsconfig path alias
  that esbuild honours.
- A refused phone (4404, 4429 on the ninth) is accepted via the hibernation
  API and closed immediately — see "Not verified" for why.

## Outside my ownership

Nothing beyond what the brief allowed: root `package.json` (workspaces,
`typecheck`, plus the one new `test:relay` script) and `bun.lock`. CI
(`.github/workflows/ci.yml`) was **not** touched; if the relay suite should
run there, add `bun run test:relay` to the `checks` job — it needs only bun
and network access to fetch workerd on first `bun install`.

## To land it

- `bun install` at the root (new workspace, lockfile updated).
- Nothing to prebuild. To deploy: `cd relay && bunx wrangler login && bunx
  wrangler deploy`, then set `RELAY_URL` for the sidecar.
- Make sure the relay-client stream sends `ping` once a minute (above).
