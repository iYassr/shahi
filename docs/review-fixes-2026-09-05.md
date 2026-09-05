# Review fixes — 5 September 2026

> Historical review. Findings and test counts refer to the revision reviewed,
> not necessarily the current release. See the [documentation index](README.md)
> for maintained guides and later assessments.

The nine findings from the project review have code fixes, with additional
integration corrections for notification ownership and client retries.

## Changes

- SSH shutdown cancels forwarding and joins its loop before releasing native
  resources. Native open/close ownership is serialized, with bounded I/O waits.
- Native reconnection rebuilds the tunnel, signs in, restores the watched pane,
  and cancels stale recovery on sign-out.
- Prompt and agent-start requests share pending and completed operations by ID.
  Both clients reuse IDs after uncertain failures. Startup waits up to 325 seconds.
- Push registrations belong to their device or login session. Revocation and
  server logout remove them; revocation during body upload cannot recreate them.
  Native SSH reconnection transfers an existing opt-in to its new login session.
- Native and web readers load earlier message pages while retaining position.
  Pagination uses message indices; transcript byte offsets remain separate.
- Codex transcripts use an incremental, bounded file-index cache and read the
  requested window plus matching tool results instead of reparsing the full log.
- The mobile relay test releases its connection; Jest exits normally.
- Privacy documentation and the public policy source describe actual relay
  telemetry, retention, and notification content.
- Compatible dependency updates and persisted security patches address the
  reviewed advisories. See [patch details](../patches/README.md).

## Web parity and responsiveness

The web app is maintained again, using mobile as its behavior reference. It now
uses semantic Shahi routes and the shared contract, with settings, device
revocation, notification controls, dashboard agent creation, pins, search,
filters, reader history, immediate prompt echo, and retry/error handling.
Layouts support narrow phone browsers and laptop widths, including keyboard
and landscape behavior. Browser connections use the page origin or an external
SSH tunnel; the native in-app SSH tunnel remains a native capability.

## Verification

| Check | Result |
| --- | --- |
| All project TypeScript checks | Passed |
| Shared/server/web/plugin unit suite | 537 passed; 26 opt-in live tests skipped |
| Dependency security regression tests | 4 passed |
| Relay suite | 53 passed |
| Mobile Jest | 217 passed across 27 suites; normal exit |
| Unsigned iOS simulator build | Succeeded, including changed Swift/Objective-C |
| Web production build | Passed; test sidecar restarted |
| Full browser development run | 161 passed, 3 failed, 1 skipped |
| Stable final browser rerun | 70 passed, 1 skipped across Chromium/WebKit |
| Responsive browser inspection | Phone and laptop screenshots reviewed |
| Diff whitespace check | Passed |

The three failures during the development browser run were a landscape CSS
breakpoint, an obsolete offline-message expectation, and assets disappearing
while a concurrent build replaced them. The final stable-build rerun covered
all three, along with changed reader, dashboard, settings, keyboard, file,
offline and stress paths. It includes twelve new parity cases across both
engines. The full suite was not repeated after this focused passing run.

## Release notes and limits

- API version is now **5**. Release the server and clients together; old clients
  will be told to update rather than silently using incompatible startup payloads.
- Old push registrations had no reliable owner and are discarded on upgrade.
  Users must enable notifications again.
- Changes and production web assets are in this workspace. The installed macOS
  service runs a separate plugin checkout; it and the public website were not
  replaced or deployed by this work. Local verification used restarted isolated
  stub sidecars, with no commands sent to live agents.
- Raw dependency audit still lists three advisories in two locally patched
  packages because it reads versions, not applied patches. No advisories were
  suppressed; the patch regression checks run in CI.
- Device-only push delivery and stalled-transfer/Address Sanitizer checks on a
  physical iPhone remain unperformed. The simulator build is not a substitute.
- Operation deduplication is bounded and process-local (ten minutes after
  completion); it does not guarantee exactly-once writes across server crashes.

## Subsequent hosted-browser implementation

The follow-up hosted PWA has now been published at `getshahi.dev/pwa/` and shares
the native encrypted relay client. See [hosting and verification](browser-hosting.md)
for current test counts, browser security boundaries, and deployment details.
The installed sidecar was subsequently upgraded to API 5 and verified connected
to herdr and the relay. The native installation still needs a matching API 5 build.
