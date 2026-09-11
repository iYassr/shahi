# Public PWA release checks — 11 September 2026

Public entry point: <https://getshahi.dev/pwa/>. The hosted PWA pairs through
Shahi's encrypted relay; the same web client ships in the approved computer
release. This assessment covers the PWA, not App Store approval or native OTA
publication. See [the security assessment](security-assessment-2026-09-09.md)
for the relay, signing, updater, and their remaining operational limits.

## Fixed release blockers

- Production returned 404 for direct `/pwa/computers` and
  `/pwa/notification?pane=…&computer=…` links. Cloudflare now rewrites both
  to the app. Unknown routes and missing assets still return 404.
- The installed app did not handle those routes offline, and its cache could
  not serve its own installation icons or manifest. The worker now serves
  those public assets and the canonical shell for valid app navigation.
  Notification identifiers are never used as cache keys or network shell URLs.
- A partially downloaded worker could activate and remove the previous complete
  cache. Installation now fails if any required public asset is unavailable,
  leaving the previous worker active.
- Automatic updates could discard an unsent message on a remembered computer.
  Drafts, attachments, submissions, and open dialogs now defer reload. Explicit
  reload requires confirmation while work is unfinished. Temporary computer
  access retains its separate warning and is never automatically reloaded away.
- New users now have computer setup commands, browser installation instructions,
  privacy/support links, and a QR scan button before the manual code field.
  Modal keyboard navigation stays within the form and restores focus on close.

## Repeatable release gate

Run `bun run build:web`, `bun run build:site`, `bun run typecheck`,
`bun run test`, `bun run test:e2e`, `bun run test:hosted`, and
`bun run test:pwa`. The GitHub browser job includes all three browser suites.

The new PWA suite runs Chrome and iPhone-sized WebKit with real service workers
enabled. It checks actual Cloudflare asset routing and headers using local
Wrangler, fresh-user setup, manifest/icons, offline navigation, three repeated
cached cold launches with relay recovery, preserved device grants, and an
interrupted worker update. Chromium additionally loses all browser networking.
The hosted fixture reads the production route allowlist; it no longer accepts
every extensionless URL and hides production 404s.

The existing encrypted hosted suite also checks concurrent computer connections,
switching and revocation, memory-only access, remembered reloads, delayed logout,
notification routing to the correct computer, QR decoding and cancellation,
encrypted file transfers, and managed update/reconnect. New checks cover draft
preservation during update and keyboard focus. All writes terminate in recording
fixtures, never real user terminals. Cache tests reject credentials, API data,
arbitrary queries, and unrelated-origin requests.

Manual browser inspection uses a disposable browser context at desktop and
390-pixel phone widths. Installation cannot be completed in that private
context; Chrome reports its private-browsing restriction. No remembered user
browser state is cleared or changed.

## Limits and user expectations

- An installed app can open its public shell offline. Live computer sessions
  require the computer to be awake, herdr/Shahi running, and internet access.
  Reconnection is automatic when service returns. Background mobile browsers
  may suspend sockets; Shahi reconnects when brought forward.
- Choose **Remember this browser** only on a trusted personal device to retain
  access across reloads and restarts. Temporary access intentionally expires on
  reload. Browser storage eviction or removal requires a new pairing code.
- A browser's installed app may use separate storage. Install first, open the
  installed app, and pair there. iPhone/iPad notifications require a Home Screen
  installation and explicit permission and enrollment for the computer.
- Playwright WebKit's complete network-offline navigation fails before calling
  its service worker. That one test is explicitly skipped; hosting and relay
  outages are tested with the worker active in both engines. Real iPhone Home
  Screen installation and background push delivery still require physical-device
  acceptance testing. Camera decoding uses a synthetic QR stream, not a physical
  camera. These checks do not establish device-specific battery behavior or a
  relay capacity/SLA under public traffic.
- Browser code is delivered over HTTPS from the managed hosting origin. Its
  cache is not a substitute for computer-release signatures, and protecting
  hosting/DNS/GitHub accounts remains part of the production trust boundary.

## Deployment record

- [Release approval 34597082632](https://github.com/iYassr/shahi/actions/runs/34597082632)
  passed for source `2fd5cbd684d1d76a1c3e2f90b88a92dd1dc4a1db`.
  CI passed 184 direct browser tests, 42 encrypted hosted tests, and 11 PWA tests
  (237 total; the documented WebKit complete-offline test is skipped). It also
  passed 614 shared/server/web/plugin unit tests, 68 relay tests, 254 native
  tests, all four platform upgrade matrices, and both live-herdr profiles.
  The broader local unit command additionally covered site and operations tests:
  619 passed, 26 skipped; four dependency backport checks passed separately.
- [Shahi 0.3.3](https://github.com/iYassr/shahi/releases/tag/v0.3.3) is Stable,
  build `0.3.3-2fd5cbd684d1`. Published archive bytes and source were verified
  against the signed approval before promotion. Stable and Beta catalogs retain
  0.3.2, 0.3.1, and 0.3.0. The Mac passed a Beta upgrade before promotion; both
  Mac and Ubuntu then reported the approved Stable build, herdr 0.9.0, relay
  connected, and unchanged pairing identity and device grants.
- Hosted deployment `dfbee8b9-9d8b-4420-8281-1f3a731bcac6` is live at
  <https://getshahi.dev/pwa/>. Ten public route/asset responses matched the local
  build byte for byte, including the previously broken routes, manifest, worker,
  icons, JavaScript, and CSS. Security headers were checked, and unknown routes
  and missing scripts remained 404.
- A disposable browser with the previous production cache upgraded to worker
  cache v8 and the new app bundle on reload. The live Computers page opened with
  browser networking disabled. A separate cold Chrome visit at 390px width,
  150ms simulated latency, 384,000 bytes/second download bandwidth, and 4× CPU
  slowdown showed first content at 2.15 seconds. This is one lab observation,
  not a phone performance guarantee or public load test.
- The first final local routing rerun overlapped an agent-triggered preview
  rebuild and returned transient asset 500s. The fixed-build rerun passed in
  both engines; CI passed with sequential build and test steps. Production
  deployment publishes the complete asset set together.
- Release approval and ordinary pushes previously shared a CI concurrency key,
  allowing one workflow to cancel or hold the other's checks. The key now includes
  the caller's workflow name; signing still requires the entire release test
  matrix and the protected master release environment. See
  [GitHub's concurrency guidance](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency#example-only-cancel-in-progress-jobs-or-runs-for-the-current-workflow).
- Disposable preview servers and both private browser test contexts were closed.
  User browser pairings and real terminal sessions were not used for test writes.
