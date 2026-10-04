# Public launch verification — 4 October 2026

This is a dated engineering verification record, not an independent security
audit or a promise of unlimited capacity. It covers the website, hosted PWA,
computer plugin/service, relay, native iPhone app, installation, operations and
public launch material. Release outcomes are recorded separately from tests.

The later [Codex Reader follow-up](#codex-reader-follow-up) records the
superseding 0.3.26 release. The original launch checks below remain dated
evidence for the 0.3.25 / build 39 artifacts.

## Initial launch scope

- Landing page: nine feature cards, public App Store download, accurate
  availability, crawler metadata, accessible mobile setup and a silent demo.
- Installer: pinned herdr downloads and digests, prerequisites, authenticated
  readiness, bounded waits and actionable failures. Existing disabled plugins
  are not silently re-enabled.
- Browser/iPhone interface: English, Arabic and Spanish, device-language
  default and a saved choice. Arabic uses right-to-left interface layout.
  Switching language must keep the current connection and unsent draft.
  Conversations, names, filenames, agent questions and terminal text remain
  in their original language. The submitted iPhone 1.1 update includes English live dictation on supported
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

## Initial release verification

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

Public 1.0.0 build 17 could not be linked to an exact source revision or EAS
build record, so its dictation availability is unproven. Landing-page and
marketing dictation claims are scoped to the verified submitted 1.1.0 build;
physical acceptance alone does not establish which version was installed.

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

## Initial release outcomes — through 03:44 UTC

| Publication | Verified state |
| --- | --- |
| Computer plugin/service | Public Stable and Beta **0.3.25**, immutable tag and GitHub Latest verified, source `3cf883c` |
| Initial website/PWA launch | Cloudflare **`7138adc0-9fae-46c5-8352-f36bec8b1d49`**, exact source `3cf883c`; replaced `d7ce91d2-b28e-48e9-be87-32009625f7ac` |
| Initial website artifact | 49 files / 3,447,014 bytes, matching Sentry upload; all **91 live probes passed** with 47 served-file hashes and two hidden metadata files |
| Actual app feature grid | **`16f01d5d-cf2b-4dd6-97f7-8271c3a59821`**, website-only source `b3231c6`; 58 files / 5,797,345 bytes; all **100 live probes passed** |
| Landing/PWA availability clarification | **`7ff7beb4-fe32-45f7-9abc-5fbc34e9f17f`**, website-only source `bfb340d`; replaced `16f01d5d-cf2b-4dd6-97f7-8271c3a59821`; 58 files / 5,797,467 bytes; all **100 live probes passed**; dictation availability clarified consistently |
| Production visual checks | Nine actual app screenshot cards, full-image privacy and caption checks; all images loaded on desktop; three desktop/one narrow-phone columns with no overflow; live English/Arabic/Spanish onboarding and saved Arabic choice verified; commands remain LTR |
| Relay | Existing healthy production deployment retained; no relay code change or unnecessary redeployment |
| iPhone | **1.1.0 (39)** submitted for automatic public release after Apple review; **1.0.0** remains publicly downloadable during review |
| Marketing | LinkedIn, X, Reddit and Show HN drafts, English/Arabic/Spanish posts, three graphics, two silent videos, captions, alt text and share ZIP prepared; nothing posted |

Evidence: [manual CI](https://github.com/iYassr/shahi/actions/runs/37170699728),
[Stable publication](https://github.com/iYassr/shahi/actions/runs/37170876540),
[website artifact and matching maps](https://github.com/iYassr/shahi/actions/runs/37170704757)
and [native build/upload](https://github.com/iYassr/shahi/actions/runs/37171091425).
The computer and native releases use frozen source `3cf883c`; the later
[website-only preview preparation](https://github.com/iYassr/shahi/actions/runs/37173221401)
uses `b3231c6`; the final
[dictation availability preparation](https://github.com/iYassr/shahi/actions/runs/37174441212)
uses `bfb340d`. The exact deployment, image review, matching maps and rollback
are recorded in [browser hosting](browser-hosting.md). Apple status was checked
again at 03:44 UTC (06:44 Riyadh): build 39 remained `VALID` and `WAITING_FOR_REVIEW`, with
automatic `AFTER_APPROVAL` release. No further native or computer release was
made for the website screenshots.

The locally generated launch ZIP (`marketing/video/out/launch-safe/shahi-launch-kit.zip`)
contains 11 files / 6,018,634 bytes. Its SHA-256 is
`180cff60535efec52a01a57c59ca900487a9a57274692653a281c1f70c9b0949`.
CRC, all ten payload hashes, copy equality and both silent video streams were
verified after the final website provenance refresh. It is a local share artifact,
not publicly hosted or posted.

## Codex Reader follow-up

The frozen fix source is `b97eac4ae026f36c5fdd836cec8a8c66bbead315`.
Computer **0.3.26** is now public on Stable, Beta and GitHub Latest. The
immutable published package keeps API 5, transport 2, manager/control 1,
data schema 1 and herdr 0.9.0–0.9.3 compatibility.

Codex 0.160.0's synchronous questions are retained from durable raw
`function_call` arguments and remain outside collapsed Activity with all
choices and descriptions. Completed async questions no longer duplicate the
generated prose or appear to be running tools. Reply objects, arrays and the
exact IDE-prefixed reply form remain readable. The mappings were checked
against pinned official Codex source
[`a956835d`](https://github.com/openai/codex/tree/a956835d020762cb2b570053af06f643a11c0ecc).

Measured question digits submit at once, including None of the above. Reader's
unnumbered **Add notes** action uses Codex's printed Tab shortcut. Focused
notes retain the question/page and selected choices. Typed submission checks
the exact panel again before Enter; a moved question, selection, cursor,
wrapped input or ambiguous spacing leaves the typed text and withholds Enter.
Actual isolated Codex Default and Plan sessions proved question navigation;
a further actual-RPC journey exercised the frozen Shahi functions, their
200 ms read guard and the durable `user_note` result. All model requests went
to a loopback fixture, with no paid prompts or owner's sessions.

The native fix keeps recent answered appearances closed across stale frames
and overlapping answers, permits newer question IDs, and restores controls for
an explicit retry after a transport failure. Editable selection keeps drafts
and the original agent wording in all interface languages.

| Follow-up check | Observed result |
| --- | --- |
| Exact-source canonical units | Local: 1,961 passed / 30 intentional skips; Linux CI: 1,960 passed / 30 skips; zero failures; five dependency regressions passed |
| Workspace types | Passed |
| Mobile units | Local: 768 passed in 73 suites; Linux: 767 passed / one platform skip |
| Full browser matrix | Chromium 211 passed; WebKit 210 passed / one skip; hosted 74, PWA 44 / two skips, dashboard 18 passed |
| Adapter and upgrade matrix | All five supported/pinned herdr legs and four OS/architecture upgrade legs passed |
| Relay units | 139 passed; no relay code/deployment change |
| Compiled native Release UI | New Codex question journey and existing Release smoke both passed; same frozen app bundle |
| Test harness correction | Loopback fixture API requests supply their synthetic stub cookie; this is a test-only follow-up and changes no app runtime |
| Immutable package comparison | Beta, manual CI and Stable candidates match all 20 extracted files / 4,128,146 bytes and all contracts; TAR metadata differences excluded |
| Actual signed upgrade | 0.3.25 → 0.3.26 → 0.3.25 preserved identity and pairing, exercised recovery/reconnect, and made zero herdr or owner writes |

Evidence: [exact-source manual CI](https://github.com/iYassr/shahi/actions/runs/37205188868),
[Beta publication](https://github.com/iYassr/shahi/actions/runs/37205190554),
[Stable matrix and publication](https://github.com/iYassr/shahi/actions/runs/37205489875),
[matching website preparation](https://github.com/iYassr/shahi/actions/runs/37205257047)
and [new native archive/upload](https://github.com/iYassr/shahi/actions/runs/37205208679).
All workflows are pinned to the frozen source above. The current published
package is [v0.3.26](https://github.com/iYassr/shahi/releases/tag/v0.3.26).

### Superseding release outcomes

| Publication | Verified current state |
| --- | --- |
| Computer | Signed Stable and Beta **0.3.26**, GitHub Latest, frozen source `b97eac4`; Stable catalog published 14:40:32.286 UTC; all 16 platform/herdr combinations select the verified package |
| Hosted website/PWA | Cloudflare **`54ac7669-6b57-4072-b334-f020f8583ad6`**, deployed 14:55:52 UTC from the exact frozen source; rollback `7ff7beb4-fe32-45f7-9abc-5fbc34e9f17f` |
| Hosted artifact and maps | Artifact `11304716603`, 58 files / 5,797,526 bytes; ZIP 3,259,895 bytes, 59 entries; matching Sentry upload completed 13:21:27 UTC; no rebuild after download |
| Production verification | All **100 probes passed** at 15:45:10 UTC: 56 served-file hashes, two hidden metadata files, routes, CSP/cache, private refusal, PWA inventory, nine unchanged reviewed screenshots and both silent videos |
| iPhone archive | **1.1.0 (40)**, EAS `7f881242-1c81-4333-abef-bc258d4f6557`, frozen source `b97eac4`, validated distribution signature, English/Arabic/Spanish permissions and isolated extension keychain groups |
| Native diagnostics | Matching JavaScript debug ID/source map and Mach-O UUID/dSYM verified; release `1.1.0`, distribution `40`, uploads enabled |
| Apple submission | Build **40 VALID**, **WAITING_FOR_REVIEW**, submitted **16:34:54.057 UTC**, **AFTER_APPROVAL**; replaces build 39 only after all archive, CI, symbol and compiled-UI gates passed |
| Public iPhone availability | **1.0.0 remains public** while Apple reviews 1.1.0; approval timing is external and is not confirmed |
| Relay | Existing healthy deployment retained; no changed relay code |

The website ZIP SHA-256 is
`33d52ef26b6b9e5034823bc13ef6f0f809dac04b5a7fda600430ccebc1e16614`.
The public computer archive is 1,214,922 bytes with SHA-256
`a2fb03c5d4c0a8e19d4350da163cab0a21a33b7e45aa355e0a397df8a6aba91f`.
Exact deployment and rollback details are in [browser hosting](browser-hosting.md).

A genuine listening-state dictation screenshot remains unavailable: the owner
cannot connect the phone now, the simulator lacks its speech model, and iPhone
Mirroring blocks microphone access. The feature image remains an honestly
captioned unsent-draft preview; no listening UI or speech availability was
fabricated. Native push acceptance and the earlier capacity/operations limits
remain as recorded above. Marketing copy and the local ZIP are refreshed for
0.3.26 / submitted build 40, without posting any content.

The refreshed local marketing ZIP contains 11 files / 6,018,546 bytes,
SHA-256 `62639ca69a63cdd9709187efc8b853838fb13171bd04680de8e4634ea7d17d0f`.
CRC, all ten payload hashes and exact copy equality passed. The three graphics,
two silent videos and captions retain their previously reviewed bytes.
Apple status was independently rechecked at **16:35:54.279 UTC**: build 40
remained VALID / WAITING_FOR_REVIEW / AFTER_APPROVAL; public version 1.0.0.
