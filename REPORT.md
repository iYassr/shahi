# Stream: security — report

Branch `stream/security`, five commits on top of `161ca96`. The full findings,
ranked, are in `docs/security-review.md`; this is what the conductor needs to
land the branch. Reviewed by hand and then by a second reviewer agent running
the `/security-review` methodology over the same files (the skill is
diff-driven and the branch had no diff, so it was pointed at the week's files);
the second read added one High finding and corrected one of my fixes, both in.

## What changed

| File | Change |
|---|---|
| `server/lib/ratelimit.ts` (new) | Fixed-window limiter keyed by client address (peer, or the **last** `x-forwarded-for` hop when the peer is loopback — the proxy's entry, not the client's). `RATE_LIMITED_PATHS` is the one-line-per-route list: `/api/meta`, `/api/auth/status`, `/api/pair/`. |
| `server/lib/session-log.ts` | `imageMediaType`: `/api/panes/:id/image` served the transcript's own `media_type` string as `Content-Type` — a planted `text/html` image block was a page on the app's origin. Now an allowlist (`png`/`jpeg`/`gif`/`webp`), else `application/octet-stream`. |
| `server/lib/http.ts` | Rate limit on the unauthenticated routes (429 + `retry-after`). `Origin` must match `Host`/`x-forwarded-host` on every non-GET `/api/*` and on `/ws` — closes CSRF from a same-site page and cross-site WebSocket hijacking; requests with no `Origin` (the native app, curl) are unaffected. Every socket's upgrade token is re-verified on each heartbeat and closed with 4001 when it no longer verifies. `maxRequestBodySize` 40MB. `clientMessageId` capped at 128 chars; receipt key framed as `JSON.stringify([paneId, id])`. `jsonObject()` helper: a non-object JSON body is a 400, not a 500. `%zz` in a pane id is a 404, not a 500. `limit`/`before` clamped to integer ranges (a NaN or negative `limit` used to read the whole transcript). `watch` is ignored for a pane the mirror does not know. Every response: `x-content-type-options: nosniff`, `x-frame-options: DENY`, `referrer-policy: same-origin`. `Content-Disposition` filename scrubbed of control characters (a newline in a filename was a 500). `SLOW_METHODS` looked up with `Object.hasOwn` (`method: "constructor"` found the prototype's). **`/api/rpc` refuses requests carrying `x-shahi-api`** (see below). `createServer` takes an optional `{ heartbeatMs }` so the re-check is testable. |
| `server/lib/codex-log.ts` | `rolloutWithinSessions`: every rollout path — from the SQLite thread index (two routes) as well as `/proc` — must be under `$CODEX_HOME/sessions/`, end in `.jsonl`, contain no `..`. The index is a file codex writes and the session id is reported from inside the agent process; neither was this server's to trust with a path. |
| `server/lib/http.test.ts` (new) | 13 tests: stands up the real `createServer` on a fake herdr and proves each fix from outside — gate, headers, rate limit by address, cross-origin POST and upgrade refused / own origin, no-Origin and proxied `x-forwarded-host` allowed, socket closed with 4001 after its cookie expires, `/api/rpc` refused to a versioned client and kept for the web client, `null` body, bad escape, oversized id, NaN/negative limits. |
| `server/lib/ratelimit.test.ts` (new) | Window, per-key independence, reopening, bounded table, path matching, `clientAddress` trusts `x-forwarded-for` only from loopback and only its last hop. |
| `server/lib/codex-log.test.ts` | `rolloutWithinSessions` accepts a rollout, refuses `/etc/passwd`, `..`, sibling directories, non-`.jsonl`, non-strings. |
| `server/lib/session-log.test.ts` | `imageMediaType` passes the four image types, turns `text/html`, `image/svg+xml`, parameterised and non-string types into an opaque download. |
| `docs/security-review.md` (new) | Findings by severity with file:line, scenario, Fixed/Deferred and why; the `e2e.ts` review; dependency audit; what was checked and found sound; a per-owner list. |

Nothing outside my ownership was edited. `auth.ts` is untouched; the login
throttle's behaviour is unchanged (login is deliberately *not* behind the new
limiter). No pairing routes existed in this worktree; `/api/pair/` is already
in the limited list for when they do.

## Verified

- `bun run typecheck` — clean (all four packages).
- `bun test shared/src server web/src` — 373 pass, 0 fail (397 ran; the
  `agents.test.ts` EBADF fault did not trigger on this run).
- `bun run test:mobile` — 14 suites, 98 tests pass.
- `bun audit` — 8 advisories, none in code that runs in the server process
  (table in the review doc).

## Not verified

- **Behind a real `tailscale serve` / `cloudflared`.** The Origin check
  accepts `Origin` = `Host` or `Origin` = `x-forwarded-host`, which covers a
  proxy that preserves `Host` and one that rewrites it. I could not run the
  PWA through a real proxy here. If a browser POST from the PWA ever comes
  back 403 `cross-origin request refused`, the proxy is sending neither
  header with the public name — check `tailscale serve` output for
  `X-Forwarded-Host`. The native app cannot hit this path (it sends no
  `Origin`).
- **The live suite** (`herdr-live.test.ts`) was not run — it needs a named
  herdr session, which the ground rules put off limits. It sends no `Origin`
  and its `/api/rpc` use, if any, sends no `x-shahi-api`, so it should be
  unaffected; CI will say.
- The rate limit is 30/min per address. A phone makes one or two of these
  calls per launch; the PWA one per load. If the WebKit e2e run (which uses
  the stub, not this server) or anything else legitimately bursts
  `/api/meta`, raise the number in `ratelimit.ts` — it is one constructor
  argument.

## One decision for the conductor

**`/api/rpc` now returns 403 to any request carrying `x-shahi-api`.** The
brief said "recommend, do not change routes another stream owns"; this route
is in `http.ts`, which this stream owns, and CLAUDE.md already states the
native app must not call it — so I enforced it (three lines, one test). It
cannot affect the shipped app, which never calls the route, or the web
client, which sends no version header. If you would rather it stayed a
recommendation, drop the `if (req.headers.has("x-shahi-api"))` block and the
"raw RPC" test; the review doc records it as M5 either way.

## Deferred to other owners (details in the review doc)

- **auth**: `Secure` cookie flag when `x-forwarded-proto: https`; no
  revocation short of rotating the secret (now a *complete* revocation, since
  sockets are re-checked); a per-address login throttle in front of the
  global one.
- **pairing / contract**: trim `/api/meta`'s unauthenticated disclosure once
  a public tunnel exists; give `/api/pair/*` a global serialising throttle as
  well as the per-address one it inherits; and three design points on
  `e2e.ts` before it carries traffic — the strict counter rejects concurrent
  HTTP requests and silently accepts dropped frames, responses are not bound
  to requests (use AAD), and the pairing secret's length is not enforced.
- **web** (archived): a CSP on the app shell.
- **mobile**: `decode-uri-component` advisory sits on the deep-link parser.
- **conductor**: `bun audit fix` (shared lockfile; not run here).

## Landing

No prebuild, no migration, no config change. Merge, `bun run typecheck`,
`bun test shared/src server web/src`, restart the sidecar.
