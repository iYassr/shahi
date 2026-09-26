# Security review — the surface that changed in the week of 2026-09-01

> Historical review. Findings and test counts refer to the revision reviewed,
> not necessarily the current release. See the [documentation index](README.md)
> for maintained guides and later assessments.

What was reviewed, what was found, and what was done about each finding.
Line numbers are as of the commit that adds this file. The threat model is
the one in `CLAUDE.md` ("Full control, gated by a passcode") and
`docs/connectivity.md` ("The one property we cannot give up"): the API behind
the gate is arbitrary shell execution as the user, so the boundary is *who can
present a valid session*, and — once a public tunnel is in front — *what a
blind relay can do with ciphertext*.

Reviewed by hand, file by file, with a second read by a separate reviewer
agent applying the `/security-review` methodology to the same files (that
skill is diff-driven and this branch had no diff, so it was applied to the
week's files rather than to a change set). The second read found one thing
the first missed (H4) and corrected one fix (M1's choice of `x-forwarded-for`
hop); both are folded in below. Everything marked **Fixed** has a test named
after the symptom in `server/lib/http.test.ts`, `server/lib/ratelimit.test.ts`,
`server/lib/codex-log.test.ts` or `server/lib/session-log.test.ts`.

## Findings, by severity

### High

**H1. A page on another origin could type into a pane with the victim's cookie.**
`server/lib/http.ts:142` (`originAllowed`), previously absent.
The server set no CORS headers and never checked `Origin`, and `req.json()`
never looked at the content type. A `text/plain` POST needs no preflight, so a
page at any origin could send `{"text":"rm -rf ~","clientMessageId":"x"}` to
`/api/panes/:id/prompt` and the browser would attach the session cookie.
`SameSite=Strict` stops that from a different *site* — but not from the same
site, and every machine on a tailnet shares the site `tailnet.ts.net`: a second
box's `*.tailnet.ts.net` page is same-site to this one. The WebSocket upgrade
had the same hole (cross-site WebSocket hijacking: read every screen). The
native app is unaffected as a *victim* — it holds its cookie itself and never
runs pages — but the archived PWA in a browser is exactly the victim.
**Fixed:** every non-GET `/api/*` request and the `/ws` upgrade must carry no
`Origin` (the native app; curl) or one whose host equals `Host` or
`x-forwarded-host`. Believing `x-forwarded-host` is safe: a browser cannot set
it on an upgrade, and setting it on a fetch forces a preflight this server
never answers. Reads are left to CORS, which already denies the page the body.
*Later (September 2026):* the Origin check never covered DNS rebinding, where
the attacking page's own name resolves to `127.0.0.1` and its requests are
same-origin. The loopback listener now also refuses with 403, before routing,
any request whose `Host` is not `127.0.0.1`, `localhost` or `[::1]` (any port),
unless the owner lists a proxy's name in `SHAHI_ALLOWED_HOSTS`. See the
pre-public-release section at the end.

**H2. A WebSocket outlived the session that opened it.**
`server/lib/http.ts:323`. The gate ran at upgrade and never again; the
heartbeat every 20s and a 90s idle timeout meant a live socket stayed live
indefinitely. A phone left on the dashboard, or a hijacked socket (H1), kept
receiving frames and dashboards after the cookie's 30-day expiry, and after a
`SESSION_SECRET` rotation for as long as the process was not restarted.
**Fixed:** the upgrade token is kept on the socket and `auth.verifyToken` is
re-run on every heartbeat; failure closes with 4001 `session expired`. The
same verifier the upgrade uses, so expiry and secret rotation are both caught
and the token format stays `auth.ts`'s business. The phone's `SessionSocket`
reconnects, gets a 401 at upgrade, and its next `session()` fetch signs it out
— existing behaviour.

**H3. codex's thread index was trusted with a path.**
`server/lib/codex-log.ts:112` (`rolloutFromSessionId`), `rolloutFromIndex`.
Two of the three rollout lookups returned `rollout_path` from
`~/.codex/state_5.sqlite` verbatim. That file is written by codex, and the
session id that selects the row is reported by a hook *inside the agent
process* (`pane.report_agent_session`). A doctored row — an agent that has
been prompt-injected has write access to `~/.codex` — made the sidecar read
that file, `fs.watch` it, and return its path in `SessionLog.path`. Content
exposure is limited because only `event_msg`/tool rows render, but a
crafted JSONL anywhere on disk would render, and the path itself leaks. The
`/proc` route already required a rollout under the sessions directory.
**Fixed:** one rule, `rolloutWithinSessions` (`codex-log.ts:71`), on all
three routes: under `$CODEX_HOME/sessions/`, ending `.jsonl`, no `..`. It is
a string check, not a `realpath`: a symlink *inside* the sessions directory
would be followed, but only by something that already has the user's shell,
to something the user can already read (see L9).

**H4. `/api/panes/:id/image` served whatever content type the transcript named.**
`server/lib/http.ts:681`, `session-log.ts:609`. `media_type` is a string in a
JSONL file the agent writes, and the agent writes what it was handed — an
image from an MCP tool result, a fetched page. It was echoed verbatim as the
response's `Content-Type`, with the record's `data` as the body: an
arbitrary-bytes, arbitrary-type responder on the app's own origin.
`nosniff` (M3) is no defence against a type the server *declared*. A planted
`{"type":"image","source":{"media_type":"text/html","data":"<base64 page>"}}`
plus a markdown link to its `/image?ref=` URL — which the PWA renders as a
real link — is a page running on this origin with the session cookie, and
`/api/rpc` one same-origin `fetch` away. The native app is not a victim
(`Image` does not execute HTML; a link opens in the system browser, which has
no cookie); the archived PWA, still served from this origin, is. Found by the
second reviewer. **Fixed:** `imageMediaType` (`session-log.ts:598`) — the same
rule `/api/file` uses: a short allowlist (`png`, `jpeg`, `gif`, `webp`; no
SVG, which runs script), anything else served as `application/octet-stream`.

### Medium

**M1. The routes before the gate answered anyone, at any rate.**
`GET /api/meta` and `GET /api/auth/status` had no limit at all. On a tailnet
that is a nuisance; on the public tunnel `docs/connectivity.md` is building
toward, it is free fingerprinting (H4) and a cheap way to keep the process
busy — each `/api/meta` is trivial, but nothing stopped ten thousand a second.
**Fixed:** `server/lib/ratelimit.ts` — a fixed window of 30 per minute per
client address, bounded to 10,000 keys, fronting `/api/meta`,
`/api/auth/status` and `/api/pair/*` (`ratelimit.ts:19`; adding a route is
one line). The address is the socket peer, or the **last** `x-forwarded-for`
hop when the peer is loopback (`ratelimit.ts:84`) — which is every request
behind `tailscale serve` or `cloudflared`, and which is exactly when the
header can be believed. The first draft took the *first* hop, and the second
reviewer caught it: a proxy appends the address it saw to whatever header the
client already sent (Go's reverse proxy and Cloudflare both append), so the
first entry is the client's to choose and a limiter keyed on it could be
reset per request by rotating the header. The last entry is the proxy's.
Once the listener was confined to loopback, "the peer is loopback" meant every
request, so the header let any local process reset its limit the same way
(September 2026 pre-release bug hunt); it is now believed only when `Host`
names a proxy the owner listed in `SHAHI_ALLOWED_HOSTS`.
Refusals are 429 with `retry-after`. `/api/auth/login` is deliberately *not*
behind it: it has `LoginThrottle`, whose behaviour this stream was told not
to change. See L6 — and note for the pairing owner: a pairing code is a
low-entropy secret, and a per-address limit is the wrong *only* defence for
one; `/api/pair/*` wants a global serialising throttle like `LoginThrottle`
as well, which no header can influence.

**M2. Request bodies were buffered before any size limit was consulted.**
`server/lib/http.ts:258`. `MAX_UPLOAD_BYTES` (32MB, `uploads.ts:27`) is checked
after `req.formData()` has already read the whole body, so Bun's default
128MB was the real ceiling on what one authenticated request made the
process hold — and `clientMessageId` had no length cap, so 500 receipts × a
large id was the receipt table's real bound, not the 500.
**Fixed:** `maxRequestBodySize` 40MB on the server, and `clientMessageId`
capped at 128 characters (a phone mints ~20). Still true: `req.formData()`
materialises up to 40MB per in-flight upload and nothing caps concurrency;
streaming to disk would close that, and is not worth it for one user's phone.

**M3. `/api/file` served agent-written files with no `nosniff`.**
`server/lib/http.ts:528`, `files.ts:63`. HTML and SVG are already served as
`text/plain` so they cannot run in this origin — but the type is chosen from
the extension, and a browser that second-guesses a `.txt` or an
`application/octet-stream` into HTML runs it with the session cookie.
**Fixed:** `harden` (`http.ts:978`) puts `x-content-type-options: nosniff`,
`x-frame-options: DENY` and `referrer-policy: same-origin` on every response,
at the same edge as compression. Framing and referrers were closed for the
same reason the cookie is `SameSite=Strict`: nothing legitimate embeds this
app or needs to know which `/api/file?path=` was open.

**M4. Hostile inputs were answered with stack traces, or obeyed.**
`server/lib/http.ts:610` and the query handling of `/session` and
`/transcript`. A JSON body of `null` was a 500 with a stack (every route read
a property off `req.json()`); `%zz` in a pane id threw from
`decodeURIComponent` — a 500; `limit=NaN` or `limit=-1` on `/session` made
`readWindow`'s start offset `undefined ?? 0` and parsed the whole transcript
(a 38MB file, for one request that asked for nothing). **Fixed:** a
`jsonObject` helper returns `{}` for a non-object body; the pane id decode is
caught as 404; `intParam` clamps `limit`/`before` to integer ranges.

**M5. `/api/rpc` is reachable by any authenticated client, including the native app.**
`server/lib/http.ts:776`. It is raw herdr: every method, no server-side
validation (the absolute-`cwd` checks on `/api/workspaces` and
`/api/agents/start` do not apply), and a direct coupling to herdr method
names that the contract exists to keep off the phone. It adds no
*capability* the passcode does not already grant — `/prompt` is shell
execution too — so this is about the blast radius of a coupling, not a new
privilege. **Fixed (and flagged for the conductor):** a request carrying
`x-shahi-api` — which only the native app sends — is refused with 403. The
archived web client and `curl` send no version header and are unaffected. A
native build that regressed into raw RPC now fails in development instead of
shipping. This is the one change here that goes beyond the brief's "recommend";
it is three lines and its own test, and is easy to drop if the conductor
prefers a recommendation.

### Low

**L1. `GET /api/meta` discloses `serverId`, the server version, the contract range and herdr's version and protocol, unauthenticated.**
`server/lib/http.ts:360`. `serverId` is a random UUID the phone binds
credentials to; it identifies the installation but grants nothing. The
versions are fingerprinting: on a tailnet, of no consequence; behind a public
tunnel, they tell a scanner exactly which Shahi and which herdr are here. The
phone needs `api` before login (to say which side to update) and uses nothing
else from the response (`mobile/src/screens/connect.tsx` only calls
`api.meta()` for the contract check). **Deferred, accepted for now:** rate
limited (M1). Dropping `herdr` and `serverVersion` from the unauthenticated
view — or moving them behind the gate — is the right shape once the tunnel
lands, and is a contract change (bump `SHAHI_API_VERSION`), so it belongs to
the pairing stream's contract work rather than to a fix here.

**L2. The `agent_blocked` fallback types the prompt into the terminal.**
`server/lib/prompt.ts:55`. When the mirror says an agent is not blocked but
herdr answers `agent_blocked`, the prompt is sent as `pane.send_text` +
Enter. If the agent has *finished* in the meantime and the pane is back at a
shell, the prompt text runs as a command. **Accepted:** that is the terminal
path's nature — a shell pane gets the same treatment on purpose — and the
person sending it holds the passcode. Worth knowing; not worth a second
round trip to re-check status, which would still race.
*Later (September 2026, F41):* the terminal path to an agent now reads the
screen first, and when the prompt parser finds an open menu whose highlighted
row is not a text field it types nothing and answers 409 `prompt_open`.
Measured on Claude Code with the cursor on "1. Yes", typing "no" and Enter had
run the command. The accepted residual above still stands: an agent that
finished and left a shell with no menu on screen gets the text as a command.

**L3. A prompt receipt could be replayed within a pane, never across panes.**
`server/lib/prompt.ts:72`. The key is `(paneId, clientMessageId)`, so the
same id on another pane is a fresh delivery, which is correct. The join was
`${paneId}:${id}` and pane ids contain `:` (`w4:p1`); no realistic collision
exists but the framing was a bare join. **Fixed:** the key is
`JSON.stringify([paneId, id])`. The table is bounded (500 entries, 5-minute
TTL, oldest evicted on insert) and holds a 40-byte receipt per entry.

**L4. Sessions are stateless and cannot be revoked short of rotating the secret.**
`server/lib/auth.ts:48`. Logout clears the cookie on the client only; a
copied cookie stays valid for the rest of its 30 days. This is a stated
design decision ("a session table would add moving parts without adding
safety") and the phone keeps the cookie in the keychain. But `auth.ts`'s own
header names "an unlocked phone in someone else's hand" as the threat, and a
logout that does not revoke does not answer it. **Deferred to the auth
owner**, with a shape that keeps sessions stateless: a single integer
"session version" in the existing `meta` table (`identity.ts` already owns
one), signed into the token and bumped by logout — one column, and logout
means something. One observation meanwhile: with H2 fixed, rotating
`SESSION_SECRET` and restarting is now a complete revocation — it ends every
socket too. *Later:* no longer complete. Server-side logout now records the
signed-out token as revoked, and a relay-paired device proves its own device secret on
every link and is issued a fresh session signed with whatever `SESSION_SECRET`
is current, so rotation ends passcode sessions but not relay pairings; those
are revoked per device (`docs/pairing.md`).

**L5. The cookie is never `Secure`.**
`server/lib/auth.ts:72`. The comment's reason is that direct `http://127.0.0.1`
development must keep working — true, and `Secure` would break
`http://100.x.y.z:7171` direct binds too. But a `Secure` flag governs only
whether the *browser* sends the cookie over plain HTTP; behind
`tailscale serve` the browser sees HTTPS and would be fine. **Deferred to the
auth owner:** set `Secure` when the request arrived with
`x-forwarded-proto: https`, and leave it off otherwise. Also no `__Host-`
prefix, for the same reason. Neither affects the native client.

**L6. The login throttle is global, so one attacker can lock everyone out.**
`server/lib/auth.ts:105`. Deliberate ("behind `tailscale serve` every request
arrives from loopback anyway" — which `clientAddress` now sees through), and
the brief said not to change it. **Deferred:** with a per-address key now
available, a per-address throttle in front of the global one would let a
scanner exhaust its own budget without slowing the owner. Note the
serialisation also caps bcrypt CPU at one verify at a time, which is a
property worth keeping. *Later (September 2026, F37):* still deferred, but
login and `/api/pair/claim` now each have their own admission budget of four
waiting requests, outside the 32 in-flight slots every phone shares; a fifth
gets 429 with `retry-after: 30`, and bodies over 4 KiB get 413. Thirty-two
wrong passcodes from any local process had held every slot for thirteen
minutes, so phones, the relay's included, were told the box was busy. A
sign-in flood can still delay or refuse the owner's own passcode login while
it lasts, including an SSH phone signing in again after a new tunnel; both
clients now call that refusal too many sign-in attempts, where the web page
had blamed the passcode and the app a missing sidecar. Pairing claims have had a throttle separate from login's since the
pentest's L1.

**L7. `/api/push/subscribe` makes the server POST to any `https://` endpoint.**
`server/lib/push.ts:80`, `http.ts:575`. An authenticated web client can
register any HTTPS URL as a push endpoint; the server then sends it a
VAPID-signed, encrypted, content-free POST on every `blocked` transition and
on `/api/push/test`. Host-controlled SSRF, but only for the person who already
holds the passcode, to a URL that receives an opaque blob. **Accepted.**

**L8. `watch` of a non-existent pane cost a poll, a herdr call and a lookup per message.**
`server/lib/http.ts:300`. An authenticated socket could send `watch` for a
made-up pane in a loop. **Fixed:** the pane must exist in the mirror.

**L9. Transcript reads follow symlinks inside the user's own directories.**
`server/lib/session-log.ts:63`, `files.ts:103`. `findTranscript` constrains
the id to `[0-9a-f-]{16,64}` and joins it under `~/.claude/projects/<dir>/`,
so no path escapes by construction; a symlink an agent planted there would be
followed, but only to something the user can already read, and a non-JSONL
target renders nothing. `/api/file` resolves through `realpath` and checks
the result against `$HOME` and the temp dir, so a symlink *out* is refused;
the window between `realpath` and the read is a TOCTOU only the account
owner can exploit. **Accepted** — CLAUDE.md already states file scoping is
tidiness, not the boundary.

**L10. A `Content-Disposition` filename with a control character was a 500.**
`server/lib/http.ts:539`. `/api/file` quoted the basename after replacing
only `"` and `\`; a newline is a legal filename on Linux and `Headers` throws
on it. **Fixed:** control characters are replaced too. *Later (September
2026):* the header now carries an ASCII `filename` fallback plus an RFC
6266/8187 `filename*` (UTF-8, percent-encoded), so a name outside Latin-1
opens and downloads under its own name.

**L11. `SLOW_METHODS[method]` found prototype members.**
`server/lib/http.ts:788`. A `method` of `constructor` on `/api/rpc` read
`Object.prototype.constructor` as the timeout, which coerced to `NaN` and
failed the call instantly — a self-inflicted refusal, nothing more.
**Fixed:** `Object.hasOwn`.

**L12. Behind the gate, more is returned than the reader needs.**
`SessionLog.path` and `sessionId` are absolute paths under `$HOME`;
`/api/dirs` returns `path` beside `display`. The phone uses the absolute path
to round-trip into herdr, which does not expand `~`, so it is needed there.
**Accepted.**

**L13. No Content-Security-Policy on the app shell.**
A `default-src 'self'` on the PWA's HTML would have blunted H4's payload. The
shell is `web/`, archived, and its bundle's needs (xterm.js inline styles)
were not measured here. **Deferred to the web owner**; the native app has no
shell to protect.

**L14. `readSessionImage` streams the whole transcript per request.**
`session-log.ts:609`. A 38MB file is scanned end to end for each image
fetch; the client caches the response as `immutable`, the server memoises
nothing. Authenticated, self-inflicted, and bounded by the reader's own
behaviour. **Accepted**; the byte-offset index already built for messages is
the shape of a fix if it is ever measured to matter.

## `shared/src/e2e.ts` — review only, not modified

The header promises X25519 + HKDF-SHA-256 + ChaCha20-Poly1305, a key per
direction, counter nonces, and replay rejection. Checked against the code:

- **Key derivation is sound as written.** `ikm = ECDH ‖ pairingSecret`,
  `salt = clientPub ‖ serverPub`, fixed `info` (`e2e.ts:77`). Both sides pass
  the public keys in the same order, so they derive the same 64 bytes and
  split them the same way. Mixing the pairing secret into `ikm` gives
  implicit authentication: without it, a man in the middle derives different
  keys and every `open` fails — the test "MITM refused" covers it. Ephemeral
  keys give forward secrecy for the pairing secret.
- **Low-order points.** noble does not fully validate X25519 public keys
  (non-canonical encodings are accepted), so point validation is *not* the
  guarantee here (corrected by the 2026-09-02 pentest, I2). What protects the
  handshake is that the pairing secret is mixed into the HKDF `ikm`: a peer
  who forces a predictable or low-order shared secret still cannot derive the
  keys without the secret, and every `open` on the far side fails. The
  all-zero point does throw, which the box now catches and turns into a link
  close rather than a crash (R1); but the security does not rest on that. Even without that, the pairing secret in `ikm` means a
  predictable ECDH output does not yield the keys.
- **Nonces cannot repeat on one key.** Separate c2s/s2c keys, an 8-byte
  counter per direction that advances on every `seal` (`e2e.ts:119`), and a
  12-byte nonce of four zero bytes plus the counter (`e2e.ts:158`). A frame
  reflected back to its sender fails to open, because the directions' keys
  differ.
- **Replay is refused, and the check cannot be abused to skip ahead.**
  `open` (`e2e.ts:132`) rejects a counter below `recv.next` *before*
  decrypting, and advances `recv.next` only *after* a successful decrypt —
  so a forged frame with a huge counter and a bad tag is rejected without
  moving the window. Both are the right order.

Three findings, all **deferred to the stream that lands the envelope** — they
are design points for how the module is *applied*, and the file was not to be
modified here:

**E1. The strictly monotonic counter fits one ordered stream, not concurrent HTTP requests.**
`docs/connectivity.md` says the envelope wraps "every WebSocket message and
request/response body". Over one WebSocket that is exactly what the counter
models. Over HTTP, two requests in flight at once arrive in either order, and
`open` will reject the legitimate one that arrives second-but-was-sealed-first
as "replayed or out-of-order". Either route all encrypted traffic over the
single ordered WebSocket, or replace the strict check with a sliding
anti-replay window (the WireGuard/DTLS bitmap: accept any unseen counter
within N of the highest seen). This is the one that will bite in testing, not
in an attack. The same check has a quieter consequence: a *forward* gap is
accepted and `recv.next` jumps past it, so a relay can drop any frame — an
error, an `unwatch`, a refusal — and the receiver never learns one existed;
and on a reordering transport, accepting frame 50 first discards 5–49 for
good. Reject gaps on the ordered-stream design, or use the window on the
other; either way the header comment should say which the transport must be.

**E2. Nothing binds a response to its request, or a frame to its type.**
ChaCha20-Poly1305 takes additional authenticated data and none is passed. A
relay holding two valid in-order s2c frames for two concurrent requests can
deliver A's response to B's request; both open. Impact today is a JSON of the
wrong shape, but it is the kind of misbinding that becomes an attack once
messages carry decisions ("accepted", "rejected"). Pass the request counter
(or a message-type tag) as AAD — `chacha20poly1305(key, nonce, aad)` — and the
swap fails to authenticate.

**E3. The pairing secret's length is not enforced.**
`PAIRING_SECRET_LEN` is exported and unused by `clientSession`/`serverSession`.
An empty secret degrades the handshake to unauthenticated Diffie–Hellman,
silently; `ikm` is `ECDH ‖ secret` with no length framing, so it would also be
ambiguous if lengths ever varied. Throw unless `pairingSecret.length ===
PAIRING_SECRET_LEN`, next to the existing 32-byte check in `ephemeral`
(`e2e.ts:71`).

Minor, noted for completeness: there is no explicit key confirmation, so a
mismatched secret is discovered on the first decrypt rather than at handshake
— acceptable, and simpler; and the pairing secret travelling in the QR's URL
fragment is the pairing stream's to get right.

## Dependencies

`bun audit` on 2026-09-01: 8 advisories, none in code that runs in the server
process. The server's runtime dependencies are `web-push@3.6.7` and
`@noble/{ciphers,curves,hashes}@2.3.0`; all clean.

| Package | Where | Advisory | Runs where | Action |
|---|---|---|---|---|
| `js-yaml` 3.15.1/4.3.0 | `json-schema-to-typescript` (server dev), jest | quadratic CPU in `!!omap` | `bun run gen:types`, tests | none needed; dev only |
| `decode-uri-component` 0.2.2 | `expo-router` → `query-string` | DoS via malformed percent-encoding | **the phone**, on deep-link parsing | mobile owner: a crafted `shahi://…?x=%%%` link could hang the app; `bun audit fix` |
| `nanoid` 3.3.16 | `expo-router`, vite/postcss | loop when size is 0 | phone (not with size 0), build | `bun audit fix` |
| `image-size` 1.2.1 | metro | infinite loop on crafted ICNS/JXL/HEIF | build only | none |
| `react-router` 7.18.1 | web (archived) | RSC-mode CSRF | PWA does not use RSC | `bun audit fix` when convenient |
| `uuid` 7.0.3 | `xcode` config plugin | buffer bounds | prebuild only | none |
| `brace-expansion` | transitive | DoS | tooling | none |

`bun audit fix` touches the shared lockfile, which every stream builds
from, so it is left to the conductor rather than run here.

## Reviewed and found sound

- The 426 contract gate (`http.ts:367`): runs before auth, discloses only the
  version range, treats an absent header as the archived client, and a
  non-integer as a mismatch.
- `findTranscript` and `readSessionImage` (`session-log.ts:63`, `:609`): the
  id and the ref are constrained; the image is located by record uuid inside
  a file already scoped by the id (its declared type is now allowlisted, H4).
- Every SQL statement (`push.ts`, `codex-log.ts`, `identity.ts`) is
  parameterised; herdr RPC framing is `JSON.stringify` of an object, so no
  delimiter reaches the socket from a client-supplied method or params.
- `transcript-watch.ts`: reports a size only, never content; watches a path
  that is now always inside a known directory (H3).
- `/api/uploads`: name sanitised (`safeName` strips separators, leading dots,
  non-conservative characters), destination fixed and owned, random suffix
  against collision, content type stored but never used to serve.
- `/api/dirs`: `realpath` then a `$HOME` prefix check; dotfiles hidden.
- Static serving: `..` segments refused before the filesystem is touched;
  the URL parser has already normalised `.`/`..`; percent-encoded forms are
  not decoded and so cannot traverse.
- Compression: no secret is ever in a response body alongside attacker
  input (the cookie never appears in a body), so BREACH does not apply.
- Logging: no route logs pane content; herdr error messages carry codes and
  ids.
- The login route: bcrypt cost 12, serialised, exponential backoff; a
  malformed hash reads as failure; a non-string passcode is now treated as
  empty rather than thrown on.
- `index.ts:121`: non-loopback binds are warned about, with `0.0.0.0` called
  out separately.

## For other owners

- **auth** (`auth.ts`): L4 (revocation), L5 (`Secure` on
  `x-forwarded-proto: https`), L6 (a per-address throttle in front of the
  global one — `clientAddress` in `ratelimit.ts` is the key to use).
- **pairing / contract**: L1 (trim `/api/meta` once a public tunnel exists),
  a global serialising throttle on `/api/pair/*` in addition to the per-address
  limiter it already inherits (M1), E1–E3 before the envelope carries anything.
- **web** (archived): L13, a CSP on the shell.
- **mobile**: `decode-uri-component` on the deep-link path; and note that the
  server now closes a socket with 4001 when its session lapses — the existing
  reconnect-then-401-then-sign-out path handles it, no change needed.
- **conductor**: `bun audit fix`; and M5 is the one change that exceeds
  "recommend" — keep or drop.

## Second review — the relay path, 2026-09-02

Requested for public release, with the relay now deployed and a phone paired
through it: a reviewer agent traced the relay Worker, the box's relay client,
the envelope, the HTTP surface, the phone's deep-link handling, the plugin and
the install path, verifying each High/Medium with runnable code. Eight
findings; the first five are fixed in the commit that adds this section, each
with a test named for the symptom (`shared/src/e2e.test.ts`,
`server/lib/relay-client.test.ts`, `server/lib/http.test.ts`).

**R1 (High, fixed). A relay-side frame crashed the sidecar.** A phone hello
whose `pub` was the all-zero X25519 point made `serverSession` throw inside
`ws.onmessage`, and under Bun an uncaught throw there exits the process —
resendable on every reconnect by anyone who knew a `serverId` and a device
id, which the relay sees in the clear. A sealed request with a non-string
`path` did the same at `req.path.split`. Both now end the link, as every
other bad frame does. No process-wide `uncaughtException` handler was added:
it would hide the next such bug.

**R2 (Medium, fixed). The envelope accepted forward counter gaps.** `open`
took any counter at or past the next one, so a blind relay could withhold a
`status`, an `unwatch` or a refusal and the receiver never learned a frame
existed (E1 above). `open` now requires exactly the next counter; a gap ends
the link, and reconnecting is the honest recovery. The review also asked for
the counter as additional authenticated data (E2): it is not added, because
the counter *is* the nonce — a frame opens only at its own counter, on this
direction's key, so a spliced or misdelivered frame already fails to
authenticate once gaps are refused.

**R3 (Medium, fixed). The pairing secret's length was not enforced** (E3
above): an empty secret degraded the handshake to unauthenticated DH, silently.
`deriveMaster` now throws unless the secret is `PAIRING_SECRET_LEN` bytes.

**R4 (Medium, fixed). The identity seed and every device secret sat in a
world-readable SQLite file.** Bun creates the database with the process umask
(0644 here). The data directory is now 0700 and the file 0600, which also
covers the WAL and shm files SQLite makes beside it.

**R5 (Low, fixed). `/api/meta` fingerprinted the box over the relay** (L1
above, re-rated now that a public path exists). Over the relay the route
answers `serverId` and `api` only; on a direct connection it still names the
Shahi and herdr versions, which the plugin's status line reads over loopback.

**R6 (Low, accepted).** A pairing-link hello for an unknown code is refused
with no throttle beyond the relay's per-phone quota. Codes are 256 bits and
live ten minutes; the claim itself is behind the global login throttle.

**R7 (Low, accepted, documented).** A Durable Object is instantiated per
attacker-chosen `serverId`. A *phone* refusal writes and schedules nothing;
a *box* connection schedules a ten-second auth-timeout alarm, one storage
write per attempt (corrected by the 2026-09-02 pentest, L3), bounded by the
per-IP front-door limiter and evicted at the timeout. Noted in
`docs/relay.md`. *Later (September 2026, F80):* the limiter keyed an IPv6
source by its full address, so one host with a /64 got a fresh budget per
address; it now counts an IPv4 address or an IPv6 /64. A larger delegation
still has one bucket per /64; the zone's WAF rule is the control for that.

**R8 (Info).** Box replacement is proven by key, and phone links are
unauthenticated at the relay by design; both verified sound.

Found sound on this pass: relay box authentication (key-to-id binding, a
signed per-connection nonce), frame parsing and per-object limits, the
pairing-link allowlist on the decrypted path (no `..`, case or query bypass),
Origin and CSRF checks, revocation on open sockets, path-traversal, SSRF and
command-injection defences, the phone's serverId-before-secret pairing check,
SecureStore and SSH host-key pinning, no HTML rendering on the phone, the
`.env` at 0600, no secrets in git history, and CI not exposing secrets to
pull requests.

## Pre-public-release review — 2026-09-22

A review of the whole product before the repository went public. Its fixes
landed together on `integrate/release-fixes`; most reach users only in the
next signed computer release after 0.3.6, the relay's on the next relay
deploy. What changed the posture recorded above, by the review's finding
numbers:

- **DNS rebinding (F26, F36).** The Origin check (H1) let a rebinding page
  through. The loopback listener now refuses any `Host` but `127.0.0.1`,
  `localhost` or `[::1]` with 403 before routing; a reverse proxy the owner
  runs, such as `tailscale serve` for Web Push, must be named in
  `SHAHI_ALLOWED_HOSTS`, and a malformed entry stops startup rather than
  widening the list. The relay's `dispatch` never passes through this check,
  and nothing a browser chose reaches it.
- **Credential floods (F37).** Separate admission budgets for login and
  pairing claims (L6).
- **Typing into an open menu (F41).** The terminal path refuses with
  `prompt_open` (L2). Answers now also carry the question and context the card
  showed, and the server requires them to match a fresh parse, because every
  Claude permission offers "1. Yes".
- **A revoked phone was never told (F34).** A phone revoked while its link was
  down reconnected forever, because the relay flattens a box's close to a
  routine `1000`. The box now answers such a phone's hello with keys from the
  revoked row's retained secret and sends one sealed `bye`, which the relay
  cannot forge. **Revoked device rows keep their secrets for this and nothing
  else**; the secret authorizes nothing once `revoked_at` is set. Revocation
  must never erase or delete a row's secret without replacing this mechanism.
  A link whose own session token merely expired gets no `bye`.
- **Relay slot squatting (F28, F33) and free frames (F79).** Anyone who knew a
  `serverId` could hold all eight pending-box slots, or all eight phone slots,
  with silent sockets and keep the real computer or phone out. The newcomer now
  evicts the longest-waiting silent socket once it is a second old. Anyone who
  also knew a device id, without its secret, could still hold every phone slot
  with hellos the box answers and holds for its fifteen-second proof deadline.
  The box now tells the relay which links proved their secret (`proven`,
  promised by `"proofs":true` in its `auth`), and on such a box a newcomer
  evicts the longest-waiting unproven link instead; a proven phone is never
  evicted. A box older than this change keeps the previous rule and that
  exposure. Every phone frame now costs at least 256 bytes of the rate bucket,
  text included. The remaining denial of service, eight fresh connections a
  second from at least three sources (one fewer for each of the owner's
  phones already connected and proven, which it cannot touch), is documented
  in `docs/relay.md`.
- **IPv6 rate limits (F80).** The relay's connect limiter, the beta signup form
  and the App Review login keyed an IPv6 client by its full address; all three
  now use the /64 (R7).
- **HSTS on the relay.** Every relay response over HTTPS, the WebSocket
  upgrade included, now carries `Strict-Transport-Security`.
- **Pairing links in the browser.** The native app has held a linked code on a
  confirmation card since pentest M2. The hosted web client opened a
  `#pair=` link straight onto a filled-in form, one tap from attaching the
  browser to a stranger's computer; it now shows the same card, so M2 is
  mitigated on both clients. The native card is now held above the router
  and shown whatever computers are saved or open; before, a link arriving
  while any computer was saved was dropped without a word.
- **SSH first use (pentest M3).** The pass above found SSH host-key pinning
  sound, but the first key was trusted silently, in the same native call that
  sent the password or key signature, and a pin could never be cleared: a
  reinstalled server stayed locked out even across an app reinstall. A
  handshake that sends no credentials now fetches the key, the app shows its
  SHA256 fingerprint and sends the login only after the person trusts it, and
  the native side refuses to authenticate without an expected key. A changed
  key shows both fingerprints and can be re-trusted by adding the computer
  again; removing or signing out of an SSH computer clears its pin unless
  another saved login uses that host and port (`docs/ssh.md`).
- **Keychain items in backups.** SecureStore's default class travels in
  encrypted and iCloud backups, so restoring one onto another iPhone cloned
  the paired-device secret, SSH credentials and passcode: two phones the
  server cannot tell apart, where revoking one revokes both. Every item now
  uses `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, and items saved by earlier builds
  move into that class on first read, copied before the original is deleted.
- **Links in a previewed PDF.** The native PDFKit preview had no delegate, and
  PDFKit's default hands a tapped link's URL to the system, so a PDF an agent
  downloaded could open another app's URL scheme, a web page or a pairing
  link with one tap. The view now ignores link URLs; destinations inside the
  document still move between pages. The web preview draws pages to a canvas
  and follows nothing.
- **Uploads.** Multipart uploads are written 0600 in a 0700 directory,
  authorization is checked again after the body arrives, and a transfer a
  device abandoned is discarded when it begins another, or after ten idle
  minutes, instead of blocking it for the hour-long expiry.
- **The OTA signing key and an unlocked CLI (F23).** The Signed Shahi phone
  update workflow ran `bunx eas-cli@23.2.0`, which pinned eas-cli and resolved
  its ~480-package tree by semver range on every publish, with the key every
  installed app trusts in the environment. It now installs eas-cli 23.2.0 from
  `.github/eas/bun.lock`, frozen with integrity hashes, into `$RUNNER_TEMP`,
  and unsets the key once it is written to a 0600 file. It is not a workspace
  dependency, because in the app's tree its older `@expo/config` would be
  hoisted over SDK 57's and change what the phone is built from, and it is
  installed outside the checkout because Metro crawls the repository root.
- **Unchecked herdr binaries and persisted tokens in CI (F64).** Pinned herdr
  tags were fetched by URL, the nightly took the newest prerelease as it was,
  and stable came from `curl herdr.dev/install.sh | sh`, on runners whose
  checkouts left the job token in `.git/config`. `.github/scripts/install-herdr.sh`
  now installs only a binary matching GitHub's SHA-256 digest for the release
  asset and, for pinned tags, the digest in `ci.yml` (for stable, the one in
  `herdr.dev/latest.json`, cross-checked against GitHub); it never runs what
  it installs. Every checkout in every workflow sets
  `persist-credentials: false`, which `.github/workflows.test.ts` enforces for
  each workflow file, and the nightly preview's issue is filed by a separate
  `report` job that has only `issues: write`, no checkout, and runs nothing but
  `gh`.

## Pre-release bug hunt — 2026-09-26

These implementation fixes extend the earlier review. They are internal checks,
not an independent security audit; source changes still require the appropriate
computer release or native binary to reach installed users.

- **Cross-computer pairing (B11).** Connect now owns its connection. A background
  snapshot cannot redirect another computer’s one-time claim to the open computer.
- **Native HTTP cache (B12).** `ShahiHttpCache` first clears URLCache.shared, then
  disables both capacities. Expo’s fetch ignored `cache: no-store`; old login
  bodies, cookies and transcripts could remain in Cache.db after sign-out. API
  responses also default to no-store. Physical upgrade verification remains due.
- **Blocking filesystem entries (B34).** File opens are nonblocking and validated
  with fstat on the handle read. FIFOs no longer pin file-work slots indefinitely.
- **Legacy host keys and Keychain services (B48, B53).** Every access drains the
  old backed-up service. Its silently accepted host keys require explicit review
  before login; saved computers merge without silently losing older entries.
- **Pairing-host ambiguity (B49).** Relay origins are normalized and restricted
  to ASCII; UI review and the destination cannot disagree on a Unicode lookalike.
- **Host parsing and proxy trust (B85).** Invalid ports are refused before URL
  parsing. Forwarded addresses are used only for an owner-allowed proxy Host.
- **Control-frame byte limits (B105).** The 4 KiB ceiling counts encoded bytes,
  so multibyte text cannot exceed the envelope budget unnoticed.
- **Listener ownership (B39).** `reusePort: false` prevents a second Bun listener
  from quietly sharing the service port on macOS.

**Production zone settings fixed and verified (B51, B52).** On 26 September,
Always Use HTTPS was enabled and Minimum TLS Version set to 1.2 through the
signed-in Cloudflare dashboard. Independent probes confirmed 301 redirects to
HTTPS and rejection of TLS 1.0/1.1 on the site, relay and review hosts; TLS 1.2
succeeded. The deployment token still cannot read or change these zone settings.
Repeat the checks in [relay operations](relay.md) after any zone change.

**Terminal startup still has a race (B4).** A command already waiting in the
terminal input queue can launch an agent’s trust menu after Shahi’s process and
screen checks. The sidecar cannot inspect that queue; the checks narrow the race
but do not prove it impossible.
