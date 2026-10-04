# Relay, computer installation and security launch review — 4 October 2026

The tested transport and installation paths passed. The launch still needs a
new approved **0.3.24 package published to Stable** after the launch changes
and required full regression CI. At this review, a fresh public installation
selects **0.3.19**, while Beta selects 0.3.23.

This is an internal readiness review. It establishes the checks below, not an
independent cryptographic audit or a production capacity guarantee.

## Public release state

Both public catalogs were downloaded from their configured GitHub URLs and
verified with the pinned Ed25519 public key using `verifyCatalog`.

| Channel | Selected version | Published | Catalog expires |
| --- | --- | --- | --- |
| Stable | 0.3.19 | 1 October 2026, 22:19 UTC | 29 January 2027, 22:19 UTC |
| Beta | 0.3.23 | 3 October 2026, 16:43 UTC | 31 January 2027, 16:43 UTC |

GitHub's Latest release was also 0.3.19. Both releases support herdr 0.9.0
through 0.9.3 / protocol 22, all four supported computer architectures, API 5
and encrypted transport 2.

The 0.3.19 computer service boots and pairs successfully. There is no evidence
that the Stable lag breaks service installation, authentication or ordinary
relay access. It does leave a first-use problem: current Claude Code can show
its folder-trust menu without writing a session record, so the older service's
Reader offers older conversations instead of recognizing that no new
conversation exists yet. Release 0.3.20 fixes that state. Its pairing-display
and browser onboarding improvements, and 0.3.23's Changes, command lists and
sealed notification actions, also require the newer approved computer package.
For the complete advertised launch experience, an updated Stable release is a
release gate.

The launch changes include updated browser assets and a dependency lockfile,
so rebuilding the existing immutable 0.3.23 release is inappropriate. Publish
0.3.24 through [the release workflow](releases.md), which runs full CI for
Stable and checks the published package's signed approval. The actual-artifact
upgrade/rollback proof below covers the existing 0.3.19 and 0.3.23 packages;
repeat the required release smoke for the new 0.3.24 artifact.

## Verification performed

| Check | Result |
| --- | --- |
| Local relay suite, independent port and disposable Worker state | 139 passed; 0 failed; 1,359 assertions |
| Targeted HTTP security, auth, configuration, secret handling and plugin suite | 223 passed; 0 failed; 1,050 assertions |
| Operations deadline, incident-state and cache suite | 7 passed; 0 failed; 34 assertions |
| Actual published 0.3.19 → 0.3.23 → 0.3.19 package smoke | Passed; signatures, lengths and archive hashes verified |
| Native upload CI/session gates and website artifact guard | 28 passed; 0 failed; 51 assertions |
| Public relay health | HTTP 200, expected service JSON, `Cache-Control: no-store` |
| Public relay cleartext HTTP | HTTP 301 to HTTPS |
| Relay HSTS | `max-age=31536000; includeSubDomains` |
| Unauthenticated fleet statistics | HTTP 401, no-store |
| Alternate `workers.dev` relay hostname | Did not resolve/connect |
| Site and relay TLS | TLS 1.0/1.1 handshakes refused; TLS 1.2 succeeded |

The published-package smoke used a temporary database, random fixture keys,
loopback HTTP port and a recording unix socket. It proved:

- A fresh 0.3.19 service boots with approved herdr 0.9.3 and pairs a disposable
  device.
- Upgrading to the actual 0.3.23 package preserves computer identity and the
  device's existing cookie; its bundled HTML and referenced assets are present.
- Its control handshake offers `changes`, `push-actions` and `commands`.
- API 4 and an unsupported newer ordinary API receive 426. A newer API can
  still read authenticated recovery protocol 1.
- An unsupported herdr moves commands into recovery while device management
  and the recovery handshake stay available. Returning the approved herdr
  restores ordinary access.
- Rolling back to 0.3.19 preserves computer identity and device access.

The recording fixture received **zero herdr writes**. No production service
was changed, no release was published and no alert/test email was sent.

## Final release artifact gate

The prepared 0.3.24 smoke requires the signed Beta catalog's pinned-key
verification and exact frozen source commit before running the package. It
checks fresh pairing, the 0.3.19 upgrade and rollback path, preserved identity
and paired-device access, API/recovery boundaries, bundled entry assets and a
stamped service worker. Its database, HOME/XDG directories and recording herdr
socket are disposable; no existing computer or agent session is used.

Stable publication should wait for a separate comparison of the signed Beta
package and the package produced by full CI on that same commit. Each archive
must match its own manifest's digest and length. Their release contracts and
complete extracted path/file contents must match exactly. Public source maps,
keys and environment files are refused by the comparison.

Compressed archive equality is not a valid expectation with the current
builder: a local experiment with identical input files produced different TAR
entry timestamps and therefore different archive hashes. The service worker,
notices and Vite debug identifiers are derived from content. The comparison
excludes container timestamps and entry order, while requiring every executable
and web asset byte to match. Existing Stable promotion checks the published
archive against its signed approval; it does not enforce equality with the
rebuilt full-CI package. The independent comparison closes that launch gate.

The website receipt guard independently passed checks for modified, missing
and extra files, wrong source commits, hidden/source/key/map paths, symlinks,
embedded credentials and malformed or oversized receipts. The native upload
guard requires a successful manual CI run on the build's exact master commit
and preserves any preexisting runner session. Actual 0.3.24 artifact results
remain pending until publication and full CI complete.

## Dependency review

The lockfile now selects brace-expansion 5.0.12 and 1.1.21, fixing three
newly reported exhaustion advisories without broad dependency updates.
The existing decode-uri-component and image-size patches remain installed.
All five bounded dependency regressions passed, including deep brace parsing
and malformed-brace rewrites in both compatible release lines.

The newly disclosed braces and node-forge advisories have no published fixed
release. The Forge proposal is unmerged and no speculative cryptographic patch
was applied. Their observed consumers are trusted Expo/Metro/Jest/EAS build
tools; neither package appears in the bundled public server or shared encrypted
transport. iOS signed-update verification uses Apple's cryptographic APIs.
These remain explicit build-tool risks, not a clean audit result. See
[the dependency review](../patches/README.md) for primary upstream sources,
the separate EAS lockfile and the exact reachability limits.

## Latest upstream compatibility

On October 4, public upstream metadata selected
[herdr 0.9.3 / protocol 22](https://github.com/herdrdev/herdr/releases/tag/v0.9.3),
[Codex 0.160.0](https://github.com/openai/codex/releases/tag/rust-v0.160.0) and
[Claude Code 2.1.289](https://downloads.claude.ai/claude-code-releases/2.1.289/manifest.json).
The herdr binary matched both its installer manifest and GitHub asset digest.
Claude's binary matched its official manifest checksum. The installed Codex
binary matched the binary extracted from its digest-verified official archive.

The latest real herdr adapter and sidecar suite passed **24 tests / 55
assertions**, with two intentional skips: a paid real-agent prompt and a
preview-only recovery test. It exercised protocol 22, snapshots, identity,
mirroring, 260 KiB shell delivery, event subscriptions, key names, HTTP auth,
API rejection, idempotent submission and the actual repository Changes view.

Startup-screen checks use temporary executable wrappers with launch provenance,
a scratch shell configuration to prevent PATH shadowing, a fresh named herdr
session and fresh agent settings. The final full replay passed **all 16
cases**, and per-case provenance confirmed the exact intended binaries.
No model prompt was sent. Claude's ten startup cases matched their existing
captures. Reviewed Codex differences are:

- An empty directory now reaches the composer without folder consent. The
  [upstream trust code](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/tui/src/config_update.rs)
  explicitly skips projectless directories. Initializing only the disposable
  test repository restores the existing trust card.
- The retired-model notice now offers Enter/Esc to continue. Shahi shows its
  screen and key controls and refuses messages until it clears. A new 0.160
  capture verifies that behavior while retaining the older choice-menu tests.
- The update offer requires a recognized installation layout. A cloned
  scratch standalone layout and synthetic 9.0.0 version record drew the real
  update card; no update choice was selected. Its new capture retains coverage
  of the existing Skip choices and digit-then-Enter confirmation.

The parser, provider-screen and live-session guard tests passed **126 tests /
382 assertions**, including both new actual Codex captures and older releases.
These checks prove current startup and adapter compatibility, not every paid
mid-conversation provider flow or future upstream releases.

## Capacity evidence and limits

`SHAHI_TEST_RELAY_PORT=18888 bun relay/scripts/load.ts 1000` passed with:

| Metric | Result |
| --- | --- |
| Synthetic computers / simultaneous phones | 1,000 / 1,000 |
| Concurrent WebSockets | 2,000 |
| 2 KiB forwarding round trips | 20,000 |
| Computer/phone reconnects | 1,000 |
| Total elapsed | 20.1 seconds |
| Round-trip p50 / p95 / p99 | 326 / 427 / 453 ms |

This uses local workerd and many independent computer objects. It does not
exercise production regions, account allowances, real AI agents, sustained
file transfers or Cloudflare's source-address limiter. It must not become a
claim that production supports thousands of concurrent users at those latencies.

The production front door permits 30 connection attempts per IPv4 address or
IPv6 /64 per ten seconds per edge location. Office networks and VPNs share that
budget. Limits remain eight phone links per computer, 64 KiB/s upload rate per
phone, 1 MiB frames, bounded client/server request queues and bounded file work.
The 32 MiB upload capability changes file size, not bandwidth. Preserve those
bounds; this small-message test does not justify increasing them.

Cloudflare dashboard verification during the launch review confirmed the
current **Workers Paid** plan. The October 2–November 1 billing period showed
27.21 thousand Worker requests against 10 million included, 8.89 thousand
Durable Object requests against 1 million included, and 12.15 thousand
GB-seconds of Durable Object duration against 400 thousand included. These
were below the included allowances at the observed point in the cycle; they
do not establish a production capacity guarantee for the launch traffic.

Three email budget alerts were verified enabled at **$10, $25 and $50**, with
configured recipients. Alerts do not cap spending, and this read-only review
did not trigger an alert or prove inbox delivery. The paid-plan and configured
budget-alert checks are closed. Read-only zone inspection also verified the
active **Shahi relay connection attempts** rate-limit rule: matching
`relay.getshahi.dev` and `/v1/`, 30 requests per source IP in ten seconds,
blocking for ten seconds. No additional custom or managed WAF rules are
configured on the Free website plan. The source admission limiter provides
the documented IPv6 prefix grouping; this dashboard rule groups by source IP.
Bot Fight Mode and Under Attack Mode were off, avoiding browser challenges
on normal API connections. No plan, billing or security setting was changed.
Distributed abuse remains an availability and cost risk despite per-source
admission limits. See [relay operations](relay.md) and
[the operating guide](operations.md).

## Current production monitoring

A read-only authenticated `GET /ops/status` at 3 October 2026, 23:58 UTC
(4 October in Riyadh) returned a check from 23:57 UTC. All 15 checks were
healthy: site, browser app, signup route availability, relay HTTP, synthetic
bidirectional tunnel, analytics, usage/hotspot analytics, signup-error signals,
relay errors, source rejections, authentication failures, reconnect storms,
alarm loops, message storms and latency. The latest tunnel check took 566 ms.
No incident was firing and recorded alert delivery failures were zero.

That is evidence of a functioning current monitor and relay path. It does not
prove end-user pairing, mobile push delivery, signup email delivery or receipt
of an alert in the operator's inbox. The status was read without running a
new probe, `/ops/check` or `/ops/test-alert`.

## Notification carrier trust assessment

The notification extension decrypts authenticated content and strips unsealed
answer data whenever iOS invokes it. The application's notification-answer path
requires a prompt ID, and the computer compares it with the current prompt
appearance before pressing any key. These IDs are cryptographic random UUIDs
inside the sealed content, and are absent from clear push routing fields.

A malicious push carrier could omit `mutable-content`, bypass the extension
and reuse a category already registered on iOS. Consequently, extension stripping
alone does not prove that a carrier can never show answer buttons. Without the
sealed current prompt ID, it still cannot construct an accepted answer; replay
also fails once the prompt changes or is answered. This review found no concrete
authorization bypass through that path. Preserve the mandatory current prompt
ID in notification actions, authenticated device ownership, fresh screen checks
and the pane's write queue. Physical-device APNs/extension acceptance remains
part of the native release checks in [notifications](notifications.md).

## Operational boundaries to keep explicit

- Keep the computer listener on loopback, with passcode configuration required,
  Host restrictions, CSRF checks and immediate device revocation. Do not expose
  its port as the public tunnel.
- Keep API 5 and encrypted transport 2 as the security floor. Missing additive
  capabilities should disable their controls while ordinary supported use works.
- The relay records bounded connection metadata; it cannot read encrypted
  session content. Marketing should say this precisely rather than claim it
  stores nothing or has received an independent cryptographic audit.
- Preserve private backups of installation secrets and a consistent database
  if computer identity/pairing must survive a disk failure. Never include those
  files in launch material or support screenshots.
- Approved package rollback is available; do not replace immutable versioned
  artifacts or restore an old database over newly paired devices.
- Headless Linux requires a persistent user service through lingering. Alpine
  still requires the user's own init supervision; do not advertise identical
  automatic supervision on every Linux distribution.
- The terminal-input-queue startup race remains documented in
  [the security review](security-review.md). Current guards narrow it and do not
  prove that it is impossible.

No additional runtime security fix was required by the tested findings in this
review. Production-like sustained and regional capacity testing, independent
cryptographic review and physical-device acceptance remain distinct work.
