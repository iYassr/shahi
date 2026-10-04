# Public launch verification — 4 October 2026

This is a dated engineering verification record, not an independent security
audit or a promise of unlimited capacity. It covers the website, hosted PWA,
computer plugin/service, relay, native iPhone app, installation, operations and
public launch material. Release outcomes are recorded separately from tests.

## Release scope

- Landing page: nine feature cards, public App Store download, accurate
  availability, crawler metadata, accessible mobile setup and a silent demo.
- Installer: pinned herdr downloads and digests, prerequisites, authenticated
  readiness, bounded waits and actionable failures. Existing disabled plugins
  are not silently re-enabled.
- Browser/iPhone interface: English, Arabic and Spanish, device-language
  default and a saved choice. Arabic uses right-to-left interface layout.
  Switching language must keep the current connection and unsent draft.
  Conversations, names, filenames, agent questions and terminal text remain
  in their original language. Live dictation remains English on supported
  iPhones running iOS 26 or later.
- Computer 0.3.25: reviewed current Codex startup captures, localized browser
  assets and notification offline-navigation fix. API 5, transport 2 and
  existing supported pairings stay compatible.
- iPhone 1.1: refreshed native binary required. The public 1.0.0 App Store
  listing was verified; an older uploaded 1.1 build is not the launch artifact.

Spanish is a launch-audience choice, not a claim that these are the world's
three largest languages. It extends English and the owner's requested Arabic
to Spain and Latin America. The reach inference is informed by
[GitHub's 2025 developer-growth report](https://github.blog/news-insights/octoverse/octoverse-a-new-developer-joins-github-every-second-as-ai-leads-typescript-to-1/)
and [Instituto Cervantes' 2025 language report](https://cervantes.org/es/sobre-nosotros/publicaciones/espanol-lengua-mundo-informe-2025).

## Completed release verification

The exact-source manual CI and Stable release matrix passed on
`3cf883cfc057407cbdb9f59e1e9419c61f97918c`. Each includes all 15 matrix
jobs and the required aggregate. The browser and native language checks cover
English, Arabic and Spanish without changing pairing identity or drafts.

| Check | Observed result |
| --- | --- |
| Canonical units, including explicitly named `.github` | CI: 1,942 passed, 30 intentional skips, zero failures; local macOS: 1,943 passed; five dependency regressions passed |
| Workspace types | Passed across shared, server, plugin, web, mobile, relay, site, operations and dashboard |
| Browser stub journeys, Chromium and WebKit | 421 passed across the two jobs, one intentional skip |
| Hosted encrypted pairing/recovery/drafts | 74 passed |
| Hosted shell/PWA cache and notification navigation | 44 passed, two intentional skips |
| Admin dashboard | 18 passed |
| Mobile units | Local macOS: 745 passed across 73 suites; Linux CI: 744 passed, one platform skip |
| Compiled native Release simulator journeys | All 11 passed: pairing, Reader/send, reconnect without duplicate writes, revoke, multiple computers, update/draft preservation, links, widths and language changes |
| Native sealed-push harness | Known-answer, tamper and routing checks passed; this does not prove APNs delivery on a phone |
| Swift crash redaction | 21 vectors passed |
| Generated third-party notices | Clean Linux/macOS agree; 100 notices and 50 license texts preserved; ancestor dependency leakage fixed |
| Workflow lint and dashboard dry build | Passed |

Latest primary upstream binaries were verified using published checksums or
archive digests: **herdr 0.9.3 / protocol 22, Codex 0.160.0 and Claude Code
2.1.289**. All 16 startup situations matched reviewed fixtures, with executable
provenance. The real-herdr suite passed 24 checks with two intentional skips;
the parser/provider/guard suite passed 126 checks. All 19 current Codex source
conversation shapes had an explicit classification.

See the [relay/security record](launch-relay-security-2026-10-04.md) for exact
load-test scope, dependency reachability, live operations and artifact rollback.

## Capacity and production operations

The relay suite passed 139 checks. A disposable local test held **2,000
WebSockets** (1,000 computer/phone pairs), completed 20,000 2 KiB round trips
and reconnected 1,000 clients. This demonstrates bounded local behavior, not
production global throughput or a long soak. Per-computer link and file-rate
limits still apply; a shared NAT can also meet front-door limits.

The live operations status reported all 15 checks healthy, no firing incident
and zero recorded alert-delivery failures. Its synthetic tunnel round trip
succeeded. No test alert or marketing message was sent.

Read-only inspection of the signed-in Cloudflare dashboard confirmed the
existing **Workers Paid** plan, observed Workers and Durable Objects usage
below their included allowances, and enabled email budget alerts at $10, $25
and $50. Alerts are notifications, not a spending cap. These measurements are
account-wide and historical; they do not guarantee launch costs or inbox
delivery. No plan purchase or billing change was made.

The existing relay rate-limit rule is active: 30 `/v1/` requests per source IP
in ten seconds, blocking for ten seconds. Application admission additionally
groups IPv6 prefixes. No additional custom/managed WAF rules are configured; browser
challenge modes are off so API connections are not challenged. This reduces
simple source abuse and does not stop distributed attacks.

Public website, PWA, privacy, relay health and media range requests were
checked. Unknown pages/APIs/assets return 404; unauthenticated fleet stats
return 401. Site/relay reject TLS 1.0/1.1; cleartext HTTP redirects to HTTPS.
No third-party website scripts were observed. Admin is protected by Access.

Cloudflare Email Routing is enabled, its DNS records are locked, and the
advertised support/privacy addresses have active forwarding rules. The domain
dashboard showed four forwarded messages in the previous seven days. No test
message was sent and mailbox receipt/staffing are not proven by that summary.

The signed, hash-verified published **0.3.19 → 0.3.25 → 0.3.19** smoke
preserved computer identity and device credentials, exercised recovery/version
gates and made zero herdr writes. The signed Beta archive and both exact-source
CI packages have identical release contracts and all 20 extracted files.
Each archive matches its own manifest hash; TAR metadata makes compressed
archive hashes differ. The previous approved computer release and recorded
website deployments remain rollback paths.

## Native release and remaining acceptance

The owner confirmed successful **live dictation on hardware**, and reported
that **native push has not been accepted on hardware**. Simulator tests and
cryptographic harnesses do not replace that check.

Fresh **iOS 1.1.0 build 39** passed production archive/upload, exact-source
manual CI, code-signature and embedded-language/permission inspection. Its
matching JavaScript source maps and native debug files were uploaded to Sentry.
The notification extension has its own active Store signing profile and only
the dedicated push keychain group; it does not receive the app's credential
group. The missing cloud signing-target discovery and a stale imported profile
were corrected before the successful build. Existing Apple distribution
certificates and public availability were preserved.

Apple accepted build 39 as `VALID`. Version 1.1.0 was submitted at
**2026-10-04 02:41:10 UTC** and verified `WAITING_FOR_REVIEW`, selecting only
build 39 with **`AFTER_APPROVAL`** automatic public release. The existing
approved 1.0.0 app remains public until Apple's decision. The existing France
exclusion and 174-territory availability were retained. Physical notification
acceptance remains unverified and must not be described as completed.

Verify on the fresh TestFlight build: foreground/background/locked delivery,
encrypted preview, long-press answer, stale question refusal, duplicate tap,
revocation, notification routing to the correct computer and one supported
legacy fallback. Follow [device verification](verify-on-device.md) and
[notifications](notifications.md); never use real work panes for write tests.

Residual build-tool advisories in braces/node-forge have no published fixes.
Their consumers are trusted Expo/Metro/EAS tooling and they do not appear in
the server or encrypted transport bundle. The existing backports and narrow
brace-expansion updates pass bounded regressions. See
[dependency review](../patches/README.md); no speculative cryptographic patch
or broad framework upgrade was made on launch day.

The independent review-demo npm lock now selects Undici 7.29.1 and Sharp
0.35.4 through scoped overrides, clearing its seven reported tooling alerts;
its frozen install, audit, types, dry build and model/archive tests pass.
Root Miniflare's ten Undici advisories remain tooling-only: a compatible
upstream update also advances its alpha Workerd engine by 23 days. Scoped
overrides are unsupported by the pinned Bun 1.3.13. The affected libraries
are absent from the traced public service, relay and review runtime bundles;
the broader tooling update needs a separate verification rather than a global
Undici major-version override that also changes Sentry's version-six client.

## Marketing and launch-day operation

[The launch kit](../marketing/launch-2026-10-04.md) contains LinkedIn posts,
X announcement/thread, tailored Reddit drafts, Show HN, press copy, FAQ,
replies, demo scripts and a seven-day follow-up plan. It separates public iOS
1.0 features from the pending 1.1 update. No social content was posted.

The wide and square silent videos are in `marketing/video/out/launch-safe/`.
Their hashes are in `site/media.json`; the new objects were uploaded before
the website references them. The existing narrated masters and the owner's
video source edits are preserved. Use these silent files or an owner-recorded
demo for commercial launch posts.

During the first wave, watch the operations dashboard and Cloudflare billing,
keep support email/GitHub issues staffed, and treat setup friction as the first
feedback target. Capture only redacted diagnostics. For a release regression,
use the recorded website rollback version or previous signed compatible
computer release; do not reset pairings or retry uncertain writes with new IDs.

## Release outcomes

| Publication | Verified state |
| --- | --- |
| Computer plugin/service | Public Stable and Beta **0.3.25**, immutable tag and GitHub Latest verified, source `3cf883c` |
| Initial website/PWA launch | Cloudflare **`7138adc0-9fae-46c5-8352-f36bec8b1d49`**, exact source `3cf883c`; replaced `d7ce91d2-b28e-48e9-be87-32009625f7ac` |
| Initial website artifact | 49 files / 3,447,014 bytes, matching Sentry upload; all **91 live probes passed** with 47 served-file hashes and two hidden metadata files |
| Production visual checks | Nine feature cards in three desktop/one narrow-phone columns; no horizontal overflow; live English/Arabic/Spanish onboarding and saved Arabic choice verified; commands remain LTR |
| Relay | Existing healthy production deployment retained; no relay code change or unnecessary redeployment |
| iPhone | **1.1.0 (39)** submitted for automatic public release after Apple review; **1.0.0** remains publicly downloadable during review |
| Marketing | LinkedIn, X, Reddit and Show HN drafts, English/Arabic/Spanish posts, three graphics, two silent videos, captions, alt text and share ZIP prepared; nothing posted |

Evidence: [manual CI](https://github.com/iYassr/shahi/actions/runs/37170699728),
[Stable publication](https://github.com/iYassr/shahi/actions/runs/37170876540),
[website artifact and matching maps](https://github.com/iYassr/shahi/actions/runs/37170704757)
and [native build/upload](https://github.com/iYassr/shahi/actions/runs/37171091425).
Each release uses the same frozen source commit. Later website-only feature
preview deployments are recorded in [browser hosting](browser-hosting.md).
