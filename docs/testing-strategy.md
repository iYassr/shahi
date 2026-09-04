# Shahi testing strategy

This is the release-quality test plan for Shahi. Its purpose is not to maximize
the number of tests. It is to put each failure at the cheapest layer that can
reproduce it, then retain a small number of real-system journeys for faults that
mocks cannot expose.

No finite suite proves that software is bug-free. The practical target is:

- every supported behavior has an owner and a repeatable check;
- every security boundary has a negative test;
- every production dependency is exercised without a mock somewhere;
- every fixed bug gains a regression test at the lowest useful layer;
- a release has objective entry and exit criteria.

## 1. System model

Shahi has seven independently fallible surfaces and six important boundaries.

| Surface | Main risks | Best primary test |
|---|---|---|
| `shared/` contract and crypto | protocol drift, malformed frames, nonce/counter mistakes | unit, property, known-answer, fuzz |
| `server/` sidecar | auth bypass, parsing errors, stale state, file access, resource leaks | unit and HTTP/WebSocket integration |
| herdr adapter | undocumented behavior changes, races, key-name drift | live contract tests against real herdr |
| transcript readers | new Claude/Codex record shapes, truncation, huge logs, partial writes | captured corpus, differential and mutation tests |
| `mobile/` app | navigation, native modules, Keychain, keyboard, lifecycle, accessibility | component tests plus Maestro and real-device UAT |
| `relay/` Worker and Durable Object | isolation, socket lifecycle, quotas, backpressure | Workers-runtime integration, protocol and load tests |
| plugin and installer | clean install, upgrade, service restart, secret permissions, uninstall | disposable macOS/Linux system tests |

The boundaries that must be tested explicitly are phone↔sidecar, phone↔relay,
relay↔sidecar, sidecar↔herdr, sidecar↔filesystem, and app↔iOS services.

## 2. Test layers

### A. Static checks — every change

Run in under a minute and block immediately:

- TypeScript type checking for every workspace.
- Expo dependency compatibility (`expo install --check`).
- formatting/lint checks once a formatter and linter are selected;
- generated herdr types are reproducible and leave no Git diff;
- lockfile is frozen;
- forbidden log patterns prevent terminal frames, secrets, cookies, or private
  keys from reaching logging calls;
- local Markdown links and configuration references resolve;
- secret scanning and dependency review on pull requests.

Static checks are useful gates, not behavioral proof.

### B. Unit and component tests — every change

Keep these deterministic, parallel, and free of network or process dependencies.

Required high-value categories:

- Every parser receives valid, incomplete, malformed, escaped, Unicode, very
  long, and unknown input.
- Every state reducer receives duplicate, delayed, reordered, and missing
  events.
- Every API error maps to user-facing language without exposing native stack
  traces.
- Every component has loading, empty, populated, error, stale, and disabled
  states where applicable.
- Optimistic sends reconcile success, delayed success, duplicate delivery,
  rejection, timeout, and reconnection.
- Permission modes map exactly to the agent flags they claim to select.
- URLs, filesystem paths, pane IDs, headers, and filenames include reserved
  characters and Unicode.

Avoid broad snapshots. Assert behavior, accessible names, and visible state.

### C. Property and fuzz tests — every change for parsers/protocols

Example-based fixtures cannot cover the input space Shahi receives from terminal
programs. Add generated tests with deterministic seeds for:

- relay encode/decode round trips;
- seal/open round trips for arbitrary binary payloads;
- strict rejection of replayed, skipped, reordered, truncated, and modified
  encrypted frames;
- pairing URL parse/serialize round trips;
- prompt parsing never invents an answer unless exactly one cursor and a
  coherent menu are present;
- transcript normalization never throws on arbitrary JSON values;
- log indexing returns the same messages as a simple full-file reference parser;
- ANSI stripping and terminal frame parsing terminate within a fixed time and
  output-size bound.

Retain every discovered counterexample as a named fixture. Run a short seeded
campaign on each pull request and a longer campaign nightly.

### D. Service integration tests — every change

Start the real Bun server with temporary data and replace only herdr at the
socket boundary. Exercise HTTP and WebSocket as an external client:

- API-version negotiation before authentication;
- login, expiry, logout, device pairing, single use, expiry, and revocation;
- authorization on every route and socket upgrade;
- Origin, forwarded-address, rate-limit, body-size, content-type, and malformed
  JSON handling;
- prompt idempotency and duplicate client message IDs;
- concurrent readers and writers;
- socket reconnect, missed-event repair, server restart, and database restart;
- uploads at 0 bytes, exact limit, one byte over, strange names, interrupted
  uploads, cleanup, and symlink/path traversal attempts;
- transcript file creation, append, replacement, truncation, rotation, partial
  final line, and deletion;
- compression negotiation and ETag/304 behavior;
- no terminal content or secrets in stdout/stderr, error bodies, or telemetry.

Use fake time where expiry behavior is under test. Use real sockets, files, and
SQLite; mocks would remove the behavior being verified.

### E. Live herdr compatibility — every pull request and nightly

The stub cannot detect contract drift. A named, isolated herdr session should
exercise the minimum supported release and current stable on every pull request,
and latest preview nightly.

The live suite must cover more than metadata:

- create and close a workspace, tab, and pane;
- launch shell, Claude Code, and Codex when installed;
- verify start retry while a shell is still initializing;
- send text, Enter, arrows, Escape, control keys, and `shift+tab`;
- read visible and recent screen sources;
- observe blocked, working, idle, done, unknown, and exited transitions;
- answer numbered, unnumbered cursor, yes/no, free-text, and permission prompts;
- confirm two sessions in the same directory remain distinct;
- restart herdr and verify Shahi reconnects without duplicating agents.

Tests must use a fresh named session and temporary workspace. Never point a
write-capable suite at a person's default herdr session.

### F. Transcript compatibility corpus — every pull request

Maintain sanitized recordings from supported Claude Code and Codex versions.
Each corpus entry needs the producer name/version and expected normalized
messages. Include:

- plain user/assistant turns;
- reasoning and streaming deltas;
- tool calls with success, failure, binary/large output, and missing result;
- nested MCP calls;
- patches, file references, images, Markdown, tables, code fences, and links;
- permission requests and `AskUserQuestion` variants;
- interrupted sessions, compaction, resume, malformed lines, and unknown future
  record types;
- multiple sessions in one project;
- logs from macOS and Linux paths.

Run the corpus against both the indexed/windowed reader and a deliberately
simple reference implementation. Their normalized output must match. Unknown
records should be counted in test diagnostics even when production safely drops
them; that turns upstream format drift into a visible signal.

Nightly, launch the latest installed agent CLIs, generate a small canonical
conversation, and compare its output shape with the corpus. Never send project
or credential content to CI artifacts.

### G. Native system tests — every pull request that changes mobile behavior

Run Maestro against an iOS Simulator build produced from the exact commit under
test, not a Metro development bundle from an unrelated checkout. The stub should
offer deterministic scenarios, while the app remains the real compiled binary.

Minimum journey matrix:

1. First launch, onboarding, manual direct connection, wrong passcode, malformed
   URL, DNS failure, refusal, timeout, TLS failure, incompatible server.
2. QR permission denied/allowed, valid pair, expired pair, reused pair, revoked
   device, malicious deep link confirmation, foreground/background pair link.
3. Empty, one-agent, blocked, mixed, and crowded lists; filters, pinning,
   scrolling, refresh, tab reselection, and dynamic updates.
4. Create an agent from Agents and Spaces; every agent kind and permission mode;
   unavailable agent; empty and Unicode names; creation race and server failure.
5. Reader rendering for every corpus block; expand/collapse, copy, links, files,
   attachments, optimistic send, failure, duplicate, retry, and scroll restore.
6. Terminal key bar, hardware/software keyboard, arrows, control keys, rotation,
   selection, zoom, long lines, alternate screen, and cursor menus.
7. Background, foreground, force quit, offline launch, network loss mid-request,
   relay loss, sidecar restart, session expiry, and automatic reconnection.
8. Settings, notification permission states, paired-device revocation, sign out,
   server switch, and persisted preferences.
9. Camera, photo picker, document picker, SSH tunnel, SecureStore, haptics,
   notifications, and deep links in both success and denial paths.
10. Smallest and largest supported iPhone, portrait/landscape, light/dark mode,
    largest Dynamic Type, Reduce Motion, RTL layout, and representative locales.

Tag a five-minute smoke subset for every mobile build. Run the full suite on
mobile pull requests and before release. Capture logs, screenshots, and videos
only on failure, with credentials and terminal content redacted.

### H. Real-device acceptance — every release candidate

A simulator does not validate APNs, camera behavior, haptics, radio changes,
Keychain persistence across upgrades, thermal/memory pressure, or actual touch
ergonomics. Test the signed release candidate on at least one older/small device
and one current/large device.

Required physical-device checks:

- install fresh, upgrade over the previous public build, and reinstall;
- pair through the production relay on Wi-Fi and cellular;
- transition Wi-Fi↔cellular, airplane mode, VPN/Tailscale on/off, lock/unlock,
  background for 30 minutes, and overnight idle;
- receive a real push while locked and open the named pane from the notification;
- camera QR scan, photo capture, file attachment, haptics, clipboard, and SSH;
- use every primary journey with VoiceOver and Screen Curtain;
- inspect largest Dynamic Type, Reduce Motion, increased contrast, Voice Control,
  and Switch Control;
- confirm no credential appears in iOS logs, screenshots, app switcher snapshots,
  pasteboard after use, or crash reports.

UAT is performed by someone who did not implement the feature. Give them goals,
not tap-by-tap instructions, and record confusion as a product defect even when
the code technically works.

### I. Relay runtime and scale — every pull request plus scheduled load tests

Move core Durable Object tests into Cloudflare's Workers Vitest integration so
they execute in the Workers runtime with real bindings, storage, alarms, and
WebSocket hibernation semantics. Keep a smaller black-box Wrangler test for the
deployed shape.

Test:

- challenge/auth success and every rejection path;
- box replacement, phone slot allocation/release, idle expiry, silent box,
  alarm rearming, object eviction and rehydration;
- strict tenant isolation across many server IDs;
- malformed text/binary frames, oversized frames, burst and sustained limits;
- slow reader, closed peer, half-open socket, backpressure, reconnect storms,
  and duplicate frames;
- telemetry failure never affects forwarding;
- production configuration has expected bindings, compatibility date, routes,
  limits, and migrations.

Load tests need three profiles:

- **steady:** realistic boxes, phones, polling, and pushes for 30–60 minutes;
- **burst:** reconnect and request spikes after relay or network recovery;
- **soak:** 24 hours with churn, alarms, hibernation, and periodic large frames.

Gate on p50/p95/p99 latency, error/close rates, memory, CPU time, Durable Object
requests, storage writes, open sockets, and account quota consumption. Run heavy
tests against a dedicated staging Worker/account, never the shared production
relay.

### J. Plugin and packaging — every release candidate

Use disposable environments because lifecycle bugs live outside the process:

- fresh macOS user with launchd;
- current Ubuntu LTS with systemd user services and lingering;
- machine with and without Bun, herdr, Claude Code, Codex, interactive-shell
  PATH setup, spaces in paths, and non-default shell;
- clean install, interrupted install, repeated install, upgrade from previous
  release, downgrade refusal, reboot/login recovery, pair, status, logs, restart,
  uninstall, and reinstall;
- verify service points at immutable expected code, starts after reboot, does not
  inherit unnecessary secrets, and stops/removes itself on uninstall;
- verify config/database modes, atomic writes, preserved passcode, and no secret
  in process arguments or logs;
- verify plugin manifest against minimum and current herdr.

Build a release artifact once, checksum it, and test the artifact that will be
published. Do not re-clone a moving branch during release qualification.

### K. Security regression — continuously and before release

Use the OWASP MASVS/MASTG for the native app and OWASP API Security categories
for the sidecar. Convert every accepted penetration-test finding into an
automated regression where possible.

Core adversarial matrix:

- unauthenticated, expired, revoked, wrong-device, and cross-box access;
- object-level authorization for every pane, file, workspace, and device ID;
- CSRF/Origin, WebSocket authentication, brute force, enumeration, and denial
  of service;
- traversal, symlinks, race-to-replace, SSRF, header spoofing, oversized bodies,
  compression bombs, malformed Unicode, and parser complexity attacks;
- relay slot squatting, quota exhaustion, fake box, replay, frame tampering, and
  link-map exhaustion;
- malicious pairing links and first-use SSH interception;
- OTA update signing/trust, dependency provenance, installer pinning, secrets at
  rest, and uninstall completeness.

Security tests must assert safe failure as well as rejection: no crash, leak,
or corrupted state. An independent review of the custom end-to-end protocol is
still required before public release; tests reduce implementation risk but do
not replace cryptographic review.

### L. Performance and reliability — nightly and before release

Create fixed baselines and fail on meaningful regression rather than absolute
machine-dependent timings.

Measure:

- cold/warm app launch, time to first agent list, pane open, reader first paint,
  send-to-optimistic-echo, send-to-sidecar receipt, and prompt-answer receipt;
- scroll hitch rate, JS/native memory, CPU, network bytes, and battery during a
  quiet pane and a busy pane;
- sidecar memory and poll cost at 1, 8, 32, and 100 panes;
- transcript indexing and window reads at 1 MB, 50 MB, 500 MB, and after append,
  truncation, and rotation;
- relay p95/p99 at realistic concurrency and near enforced limits;
- reconnect time and lost/duplicated action count after every process/network
  failure.

Run long-lived soak tests for the app, sidecar, herdr, and relay together. During
the soak, randomly restart one component, suspend the phone, rotate logs, change
networks, and create/close panes. Invariants: no action is silently duplicated,
no authorized state crosses devices/boxes, memory returns near baseline, and the
UI becomes current without manual refresh.

## 3. CI and release gates

| Gate | Trigger | Must pass |
|---|---|---|
| Fast | every push/PR | static, typecheck, unit/component, short property tests |
| Integration | every PR | sidecar external API/WS, Workers runtime, web reference |
| Compatibility | every PR | minimum + stable herdr live suite |
| Mobile | mobile-affecting PR | exact-commit simulator build + smoke/full Maestro |
| Nightly | schedule | herdr preview, long fuzz, agent corpus probe, soak and leak tests |
| Release candidate | tag/manual approval | clean plugin installs, full native suite, staging relay load, signed physical-device UAT, security checklist |
| Production canary | after deploy | synthetic pair/connect/read/answer using dedicated canary box and phone identity; rollback on failure |

A release is blocked by:

- any failing required test or unexplained flake;
- any open Critical/High security finding;
- crash-free or latency regression beyond the agreed budget;
- an untested migration, installer change, native dependency, relay migration, or
  OTA configuration change;
- missing test evidence for the exact commit and exact signed binary being
  released.

Quarantine is allowed only with an owner, issue, reason, expiry date, and proof
that the quarantined check cannot hide release-critical behavior. Retrying until
green is not a test strategy.

## 4. Test-data and environment rules

- Fixtures contain synthetic or sanitized data only.
- Every integration test owns a temporary directory, database, ports, herdr
  session, server ID, device ID, and cleanup path.
- Stable clocks, random seeds, locale, timezone, and device model are recorded.
- Live tests never use the developer's default herdr session or production relay.
- A test that mutates external state names the isolated target in its output.
- CI artifacts redact authorization headers, cookies, passcodes, pairing secrets,
  SSH material, terminal frames, home-directory usernames, and transcript text.
- Failed UI runs retain the app binary identifier, commit SHA, OS/runtime, flow,
  screenshot, device logs, sidecar logs, and stub scenario.

## 5. Coverage measurement

Line coverage is a diagnostic, not the target. Track four views:

1. **Requirement coverage:** each supported user capability has at least one
   system-level check.
2. **Boundary coverage:** every boundary has success, rejection, timeout,
   interruption, replay/duplicate, and recovery tests.
3. **Code coverage:** collect branch coverage from unit/integration suites and
   investigate unexecuted security/error branches.
4. **Mutation score:** periodically mutate auth, parser, crypto-counter,
   idempotency, and size/rate-limit decisions; tests must kill the mutations.

Begin with reporting only. Set thresholds after a trustworthy baseline, then
ratchet them upward. A blanket percentage encourages low-value tests and can
still leave the dangerous branches untouched.

## 6. Highest-priority gaps in the current repository

The repository already has substantial unit, browser, relay, pentest, live-herdr,
and Maestro coverage. The next investments, in order, should be:

1. Run Maestro automatically against an exact-commit iOS simulator build in CI;
   today the flows exist but GitHub CI does not execute them.
2. Add a sanitized, versioned Claude Code/Codex transcript corpus and a nightly
   live producer probe.
3. Test the Durable Object with Cloudflare's Workers Vitest runtime, including
   hibernation, alarms, eviction, and storage—not only `wrangler dev`.
4. Build disposable macOS and Linux plugin lifecycle tests, including reboot,
   upgrade, interruption, and uninstall.
5. Add property/fuzz and differential tests for the prompt parser, transcript
   indexer, relay frames, and E2E counters.
6. Add automated accessibility audits and manual VoiceOver UAT for every screen.
7. Establish performance budgets and a 24-hour end-to-end soak with fault
   injection.
8. Add a staging relay and a synthetic production canary; production should not
   be the load-test target.
9. Exercise real APNs delivery, camera, haptics, Keychain upgrades, and SSH on
   physical iPhones.
10. Update `docs/verify-on-device.md`; its opening claim that the native app has
    no automated tests is now stale.

## 7. Recommended first implementation slice

Keep the first slice small enough to land without destabilizing the product:

1. Add coverage reports for Bun/Jest without enforcing arbitrary thresholds.
2. Add deterministic property tests for pairing, prompt menus, relay envelopes,
   and transcript indexing.
3. Add an EAS workflow that builds the simulator app from the tested commit and
   runs the existing Maestro smoke tag.
4. Add three sanitized Claude and three Codex corpus sessions with expected
   normalized output.
5. Add Workers Vitest tests for authentication, slot release, alarm expiry,
   hibernation restoration, and tenant isolation.
6. Refresh the physical-device checklist and execute it against the signed
   release candidate.

Only after this slice is stable should the suite expand into large device
matrices, continuous load, mutation testing, and fault-injected soak runs.

## References

- [Expo: unit testing with Jest](https://docs.expo.dev/develop/unit-testing/)
- [Expo: E2E tests with Maestro on EAS Workflows](https://docs.expo.dev/tutorial/cicd/e2e-tests/)
- [Maestro: iOS black-box testing](https://docs.maestro.dev/getting-started/build-and-install-your-app/ios)
- [Cloudflare: testing Durable Objects](https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/)
- [Apple: performance tests](https://developer.apple.com/documentation/xctest/performance-tests)
- [Apple: accessibility audits](https://developer.apple.com/documentation/accessibility/performing-accessibility-audits-for-your-app)
- [Apple: VoiceOver testing](https://developer.apple.com/documentation/uikit/supporting-voiceover-in-your-app)
- [OWASP MASVS and MASTG](https://mas.owasp.org/MASVS/)
- [OWASP API Security](https://owasp.org/API-Security/)
