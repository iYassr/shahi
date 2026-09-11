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

Release publication, live asset verification, and machine upgrade results are
recorded below after the approved release completes.
