# Relay, computer installation and security launch review — 4 October 2026

Public Stable and Beta now select **0.3.25**, built from frozen commit
`3cf883cfc057407cbdb9f59e1e9419c61f97918c`. Both signed catalogs were
verified with the pinned Ed25519 key. The actual published package passed fresh
pairing, upgrade and rollback, recovery and bundled-asset checks. Its complete
extracted contents match both full-CI builds on that exact source commit.

This is an internal readiness review. It establishes the checks below, not an
independent cryptographic audit or a production capacity guarantee.

## Public release state

| Channel | Selected version | Catalog published | Catalog expires |
| --- | --- | --- | --- |
| Stable | 0.3.25 | 4 October 2026, 02:34 UTC | 1 February 2027, 02:34 UTC |
| Beta | 0.3.25 | 4 October 2026, 02:22 UTC | 1 February 2027, 02:22 UTC |

GitHub's [Latest release](https://github.com/iYassr/shahi/releases/tag/v0.3.25)
is also 0.3.25, with draft and prerelease disabled. Its immutable version tag
points directly at the same frozen commit. Catalog selection was checked on
all four platforms with Bun 1.3.13 and herdr 0.9.3. The approved package
supports herdr 0.9.0 through 0.9.3 / protocol 22, all four supported computer
architectures, API 5 and encrypted transport 2.

The initial review selected Stable 0.3.19 and Beta 0.3.23. The older Stable
service installed, authenticated and relayed successfully, but current Claude
Code's folder-trust menu could appear before any session record existed, leaving
Reader showing older conversations. The newer approved Stable includes the
first-use fix, pairing/browser onboarding changes, Changes, command lists and
sealed notification actions. The computer-package release gate is now closed.
Physical-device notification acceptance and App Store publication are separate
native release checks.

## Verification performed

| Check | Result |
| --- | --- |
| Local relay suite, independent port and disposable Worker state | 139 passed; 0 failed; 1,359 assertions |
| Targeted HTTP security, auth, configuration, secret handling and plugin suite | 223 passed; 0 failed; 1,050 assertions |
| Operations deadline, incident-state and cache suite | 7 passed; 0 failed; 34 assertions |
| Actual published 0.3.19 → 0.3.25 → 0.3.19 package smoke | Passed; signatures, lengths and archive hashes verified |
| Signed Beta vs manual CI and Stable-run package contents | Passed; exact source commit, contracts and all 20 extracted files match |
| Clean macOS and Linux notice ownership checks, Bun 1.3.13 | 9 passed; 0 failed; 21 assertions on each OS |
| Native upload CI/session gates and website artifact guard | 28 passed; 0 failed; 51 assertions |
| Public relay health | HTTP 200, expected service JSON, `Cache-Control: no-store` |
| Public relay cleartext HTTP | HTTP 301 to HTTPS |
| Relay HSTS | `max-age=31536000; includeSubDomains` |
| Unauthenticated fleet statistics | HTTP 401, no-store |
| Alternate `workers.dev` relay hostname | Did not resolve/connect |
| Site and relay TLS | TLS 1.0/1.1 handshakes refused; TLS 1.2 succeeded |

The published-package smoke used a temporary database, random fixture keys,
loopback HTTP port and a recording unix socket. It proved:

- A fresh 0.3.25 service boots with approved herdr 0.9.3 and pairs a disposable
  device; the historical 0.3.19 service also boots and pairs before the upgrade.
- Upgrading to the actual 0.3.25 package preserves computer identity and the
  device's existing cookie; its bundled HTML and referenced assets are present.
- Its control handshake offers `changes`, `push-actions` and `commands`.
- API 4 and an unsupported newer ordinary API receive 426. A newer API can
  still read authenticated recovery protocol 1.
- An unsupported herdr moves commands into recovery while device management
  and the recovery handshake stay available. Returning the approved herdr
  restores ordinary access.
- Rolling back to 0.3.19 preserves computer identity and device access.

The recording fixture received **zero herdr writes**. No production computer
service or agent session was changed, and no alert/test email was sent. Public
release publication was performed separately through the protected workflow.

## Final release artifact gate

The final source is `3cf883cfc057407cbdb9f59e1e9419c61f97918c`. The
[manual full-CI run](https://github.com/iYassr/shahi/actions/runs/37170699728),
[Beta release](https://github.com/iYassr/shahi/actions/runs/37170702958) and
[Stable release](https://github.com/iYassr/shahi/actions/runs/37170876540)
completed successfully on that same commit. The immutable earlier 0.3.24
package was preserved; the final corrections received the new 0.3.25 version.

The published 0.3.25 archive was verified against its pinned-key signed Beta
approval, then compared separately with the actual package artifacts from
manual full CI and the Stable workflow. Each archive matched its own manifest's
SHA-256 and length. Their release contracts and every extracted file matched
exactly: **20 files, 4,124,458 expanded bytes**, with payload fingerprint
`1c5402540dc02889acd6256a0cc10f7b6f3aea078050285a321a1e401e2300c7`.
The signed Stable catalog independently approves that same published manifest.
Public source maps, keys and environment files were refused by the comparison.

The actual published-package smoke passed fresh pairing and the
**0.3.19 → 0.3.25 → 0.3.19** path, preserved identity and paired-device
access, rejected unsupported ordinary API versions, retained authenticated
recovery, recovered after an unsupported herdr, served all four referenced
entry assets and contained a stamped service worker. Its database, HOME/XDG
directories and recording herdr socket were disposable; no existing computer
or agent session was used. Production writes and herdr writes were both zero.

Compressed archive equality is not a valid expectation with the current
builder: TAR entry timestamps change archive hashes even when files match.
The service worker, notices and Vite debug identifiers are derived from
content. The comparison excludes container timestamps and entry order while
requiring every executable and web asset byte to match. Existing Stable
promotion authenticates the published archive against its signed approval;
it does not enforce equality with the rebuilt full-CI package. The independent
comparison closes that launch gate.

The failed earlier notice check was traced to resolving an optional peer in
unrelated ancestor `node_modules` outside the checkout. The corrected lookup
stops at the installation root and retains installed optional peers inside it.
Clean macOS and Linux with official Bun 1.3.13 both reach 900 package directories
and 786 unique package/version IDs, with the same closure digest. Regeneration
preserved all **100 notices and 50 distinct licence texts**; only the closure
hash changed. Existing bundled-package, autolinked-native, actual-licence and
external-Pods checks remain intact, alongside the new boundary regression.

The website receipt guard independently passed checks for modified, missing
and extra files, wrong source commits, hidden/source/key/map paths, symlinks,
embedded credentials and malformed or oversized receipts. The native upload
guard requires successful manual CI on the build's exact master commit and
preserves any preexisting runner session. These guard checks do not establish
App Store approval or physical-device notification delivery.

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

GitHub's seven open Dependabot alerts were independently read and reconciled:
all referred to development dependencies in `demo/package-lock.json`, not the
root Bun lockfile. Six were Undici 7.29.0 advisories and one was Sharp 0.35.2's
libheif advisory. Scoped npm overrides now select Undici 7.29.1 and Sharp
0.35.4 in that separate demo lockfile. Direct dependency versions are unchanged.
Its frozen install and audit returned zero advisories; types, worker dry-run,
five simulated-model tests and four state/archive tests passed. No demo
deployment or live session was changed. GitHub's current SBOM independently
indexes Undici 7.29.1 and Sharp 0.35.4, while the final alerts API read still
reports the seven old demo findings open. The alert state is reported
separately from the verified dependency versions; none were dismissed or
suppressed.

The full root audit additionally reports ten Undici 7.29.0 development-tool
advisories through Miniflare: two high, five moderate and three low. Bun
1.3.13's scoped-override forms were tested in isolation and do not change that
pinned dependency. The first inspected fixed Miniflare release also advances
the alpha Workerd engine by 23 days; that wider update is deferred. A global
Undici 7.x override would replace Sentry CLI's separate 6.x dependency and was
not applied. The current five production-scope audit results therefore remain
distinct from the 15 full-workspace version-based findings.

Fresh frozen-source bundle graphs included 156 computer-service modules,
eight relay modules and 95 review-controller modules, with no Undici, Sharp,
braces or node-forge inputs. The reviewed Miniflare uses Undici's `Pool`, rather
than the `BalancedPool` configuration affected by the TLS callback advisory.
No new public-runtime high-severity blocker was demonstrated. The unresolved
tooling risks remain documented rather than dismissed or suppressed.

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
