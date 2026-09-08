# Release readiness assessment — 5 September 2026

**Verdict: broad local validation passed; this is not yet an unconditional public-release sign-off.**
The remaining gates are the actual signed release on a physical iPhone, native
SSH and push validation, a longer soak, and the production browser findings
below. No deployment or release was performed.

Tested on macOS with Bun 1.4.0, the iOS 26.5 simulator, and five OrbStack VMs
using Bun 1.4.1 and herdr 0.8.2. The checkout starts at `074215f` and contains
uncommitted work from another ongoing effort. Results describe the working
tree, not an immutable release commit. A file-hash manifest and command logs
are saved in `test-results/release-2026-09-05/` (ignored by Git).

## Results

| Check | Result | Scope and limits |
| --- | --- | --- |
| TypeScript | Passed | Shared, server, plugin, web, mobile, relay, relay tests, site, operations |
| Mac unit suite | 576 passed; 26 skipped | Skips are the opt-in live-herdr group; separately exercised below |
| Dependency regression checks | 4 passed | Security backports and xcode identifier generation |
| Debian unit suite | 571 passed; 26 skipped | Shared/server/web/plugin; excludes site and operations from the Mac command |
| Native components | 221 passed across 28 suites | Includes API, relay, SSH/tunnel, pairing, reader, settings and recovery |
| Local Worker relay | 60 passed | Crypto/protocol handling, limits, malicious frames, slow reader isolation, oversized streaming cancellation, per-device concurrency |
| Chromium + WebKit | 178 passed; 1 skipped | Navigation, prompts, keyboard, reader, files, recovery, idle polling, memory/stress scenarios |
| Hosted Chromium + WebKit | 20 passed | Separate static origin, encrypted pairing, revocation and browser persistence |
| Real herdr on Mac | 22 passed | Includes starting a real Claude and delivering a semantic prompt in a scratch session |
| Real herdr on each Linux VM | 21 passed; 1 skipped per VM | Ubuntu x86_64; Debian, Fedora, Arch and Alpine ARM64. Real-agent test disabled on VMs |
| Native simulator | Final expanded XCUITest passed | Pairing, actual transcript, scroll away from tail, reading-mode retention, keyboard send, resume, disconnect/reconnect, exactly two recorded writes, revocation |
| Web and hosted builds | Passed | Rebuilt before the final browser runs |
| iOS production JS export | Passed | Hermes bundle about 4.5 MB; not a signed native release/archive |
| Public HTTP | 15/15 curl requests returned 200 | Five each to the website, `/pwa/`, and relay health; approximately 283–381 ms total |

The WebKit skip is explicitly the offline-navigation scenario that Playwright
cannot emulate in that engine. Native XCTest ran against the current development
app and a local encrypted recording fixture. Its final result bundle is
`mobile/uitests/build/release-reliability-5.xcresult`. Earlier setup failures are
retained in logs; they are not counted as product regressions or hidden as passes.

All command-producing integration tests used recording stubs or explicitly
named scratch herdr sessions. Default herdr sessions and real transcripts were
not modified. Scratch herdr sessions were stopped after testing.

## Speed and short-duration stability

| Experiment | Work | Result |
| --- | --- | --- |
| Local sidecar | 6,000 authenticated session reads, batches of 20, about 61 seconds, empty real herdr session | 0 errors; p50 1.36 ms, p95 3.19 ms, p99 5.91 ms |
| Sidecar memory/startup | Same experiment | Startup about 109 ms; sampled RSS 63.2 MiB initially, 49.2 MiB finally, 65.2 MiB peak; no active operational alerts |
| Local relay, light load | 10 synthetic boxes + 10 phones; 200 round trips; 10 reconnects | Passed; p50 8.2 ms, p95 12.8 ms, p99 14.4 ms |
| Local relay, heavy load | 1,000 boxes + 1,000 phones; 20,000 2 KiB round trips; 1,000 replacements/reconnects | Passed; p50 1,131 ms, p95 1,708 ms, p99 1,886 ms; about 65 seconds |

These are local measurements, not WAN or production capacity guarantees. The
heavy run shared the Mac with other checks and drove many Durable Objects
through one local workerd. It proves successful forwarding and replacement
under that workload; its latency shows why it is not a responsiveness claim.
The sidecar test does not cover large transcripts or many active agent panes.
Its final in-flight count of one includes the diagnostics request itself.
One minute does not establish absence of long-term leaks.

An earlier benchmark mistakenly used the installed VMs' API v4 against the
checkout's API v5. All 6,000 requests were rejected. Those timings are invalid
and excluded above. The corrected benchmark discovers the server's contract.

## Fixes made while testing

- Guarded the operations monitor's optional timer before clearing it, fixing
  the TypeScript build failure.
- Repaired the live-herdr HTTP fixture to configure bcrypt authentication,
  log in, carry its session cookie, and explicitly disable external relay/env
  configuration. The old fixture depended on unauthenticated server startup,
  which production correctly refuses.
- Made the directory test create and remove its own visible home entry; a
  fresh VM is allowed to have only hidden directories.
- Removed the plugin security test's dependence on Bun placing `.bin` first.
  The hostile PATH fixture is explicit, and service selection still must
  refuse the malicious executable. Bun's Linux PATH lookup behavior differs
  from the Mac's.
- Added the isolated native release flow, fixture disconnect injection and
  delivery-acknowledgment handling, plus selectable Xcode result paths and
  instructions in `mobile/uitests/README.md`.

The existing Maestro flows still describe the removed typed-address login
screen. They were not counted as passing native coverage and should be updated
or replaced. The new XCUITest exercises current pairing rather than restoring
an obsolete login path for tests.

## Architecture assessment

The existing separation is appropriate: clients share a versioned contract
and encrypted transport, the sidecar translates semantic routes to herdr,
and the relay forwards opaque frames. The successful real-herdr suites across
both CPU architectures and glibc/musl provide evidence for the adapter boundary.
Crypto and transport tests support revocation, bounded requests, retry handling,
and isolation of a slow phone from a healthy one.

Transcript indexes and windowed reads are covered by existing append,
truncation/replacement, UTF-8 and bounded-retention tests. They were not newly
benchmarked with a large multi-pane corpus in this run.

Two concentrations remain maintenance risks: `server/lib/http.ts` is about
1,370 lines, and the native pane screen about 1,690. This is a reason to keep
extracting cohesive responsibilities as behavior changes, not evidence that
a rewrite is needed before release. No architectural rewrite was attempted.

Operation deduplication remains process-local and bounded. It does not promise
exactly-once execution across a sidecar crash. The local relay load run also
does not test production WAF limits, regional failure, or global reconnect
storms. An external review of the custom encryption construction remains
outside this functional assessment.

All installed VM services answered and reported relay connectivity. The four
systemd machines reported zero restarts. Alpine's sidecar works, but this does
not establish supervised installation support: OpenRC integration is absent.
Those installed services advertise API v4; the current checkout advertises v5.
Update the sidecar when testing the release app against those installations.

## Remaining release gates and findings

1. **Test the actual signed release on a physical iPhone.** Native push token
   registration/delivery/tap navigation, camera pairing, SSH establishment and
   host-key prompts, dictation, keyboard behavior, Wi-Fi/cellular transitions,
   and long background/resume cycles are not proved by this simulator run.
2. **Investigate the production script element.** A fresh browser context
   displayed a `static.cloudflareinsights.com/beacon.min.js` script on `/pwa/`.
   Resource entries had status 0 and zero transferred bytes, consistent with
   CSP blocking it. The curl HTML did not contain the element. Determine its
   source and remove any edge/browser analytics injection: the project and
   privacy copy require an origin without third-party scripts. This observation
   does not establish execution, tracking, or session exposure.
3. **Check returning-browser recovery.** The existing browser profile initially
   showed `LIVE` and `Connecting to herdr…` without pairing storage. A fresh
   isolated context correctly showed pairing. The cause was not established;
   validate an upgrade from the previously deployed PWA and its service worker.
4. **Freeze and rerun against the release candidate.** Other files changed
   during this assessment. Commit the intended release, install/build that exact
   version, and retain a matching evidence manifest. Do not interpret a working
   tree pass as certification of a later binary.
5. **Run a longer representative soak.** Include large transcripts, several
   active panes, disk pressure, sidecar restart, native SSH reconnection, and
   network transitions. The short local runs here are not a substitute.

Python HTTP probes received 403 for all public endpoints while curl and a fresh
browser succeeded. Client-dependent filtering is plausible, but was not
root-caused. Do not classify those Python responses alone as a user-facing
outage or an application performance measurement.

## Production remediation verification

The operations/remediation task subsequently resolved finding 2. Site version
`5335cbb1-7422-48fa-bd79-9505a0e8d8e2` sends `Cache-Control: public, no-transform`
to prevent proxy injection while retaining the PWA's same-origin script CSP.
Public HTML fetched with a Chrome User-Agent contained only first-party
scripts on `/`, `/pwa/`, and a nested PWA route, and no scripts on `/privacy`.
A live Chrome navigation to an uncached PWA URL also reported zero external
script elements. The earlier observation remains a record of the pre-fix
deployment and did not establish that the beacon executed.

The installed Mac sidecar was restored to its original herdr socket after the
scratch-session startup hook had repointed its LaunchAgent. The restored
service answered authenticated diagnostics with HTTP 200, relay connectivity,
and no local alerts. The operational cron reported all checks healthy at
2026-09-05 02:57 UTC, with zero email delivery failures. This follow-up does
not close the physical-device, returning-browser, release-freeze or soak gates.
