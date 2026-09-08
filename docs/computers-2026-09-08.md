# Saved computers and herdr 0.9.0 — September 8, 2026

The native app previously overwrote its one saved connection on every pairing.
Settings' device rows list phones/browsers authorized on the selected server;
they cannot recover credentials for other computers.

Settings → Computers now retains SSH and encrypted relay credentials in the
phone's SecureStore, switches the active transport without revoking other
connections, and offers Add a computer. The connect screen also offers saved
computers. Signing out forgets only the selected computer. Previously overwritten
credentials require one new pairing; server device rows do not contain secrets
that could reconstruct them.

Pins belong to each computer. A switch retires the old socket/tunnel, clears the
session, prompts, reviews and reader cache, and resets navigation. Late outgoing
socket/HTTP replies cannot replace the next session or sign it out. A failed
SSH connection leaves the saved computers available for retry or switching back.

## Validation

- All-project TypeScript check passed.
- Shared/server/web/plugin suite: 576 passed, 26 opt-in cases skipped.
- Mobile suite: 232 passed in 31 suites. Added coverage for switching both ways,
  cold restoration, pins, late HTTP/socket responses, sign-out isolation, failed
  SSH, keychain failure and direct re-pairing.
- Native iOS simulator: paired two independent encrypted fixtures, switched
  A → B → A, restarted and restored B, then returned to A. Three synthetic
  messages were delivered only to their intended fixture (two to A, one to B).
  Result: mobile/uitests/build/computers-2026-09-08.xcresult.
- herdr 0.9.0, protocol 22: schema regenerated and CI/plugin minimum aligned.
  macOS arm64: all 22 live tests passed, including a real Claude agent.
  Debian arm64: 21 passed; real-agent case not enabled.
  Ubuntu x86_64: 21 passed; real-agent case not enabled.

The Linux runs exposed assumptions in the live test fixture: it wrote before
subscription acknowledgement, assumed terminal output produced structural events,
and let key-bar tests leave shell editing state in the next prompt test. The
fixture now waits for subscription, renames its own scratch workspace to exercise
an event, and gives HTTP submission a fresh scratch shell.
All writes used isolated stubs or named herdr sessions; no default herdr session
was used. Tests assert terminal markers as booleans rather than dumping screens
on failure.

Native push delivery on a physical phone remains outside these tests. This is
compatibility and switching validation, not a claim of exhaustive release testing.

## Phone preview

Expo iOS internal preview completed successfully at 2026-09-08 06:32 UTC:
https://expo.dev/accounts/yasserd99/projects/shahi/builds/43457a9b-1d44-4beb-865e-40be17d44c76

Install QR: test-results/computers-2026-09-08/install.png. This is an installable
preview for registered devices, not an App Store release. The server/schema and
CI changes are in this workspace; no production sidecar was restarted.

## Native disconnect follow-up

The Agents screen's offline “Switch server” action called signOut, deleting the
selected credential and opening onboarding. It now navigates to Computers. The
connection-health banner also offers Switch computer. When access ends or a cold
SSH restore fails, Connect redirects to the saved-computer list; explicit Add a
computer keeps onboarding available through provider-owned intent state.

Regression coverage includes the actual Agents switch callback (no signOut), the
banner action, the default saved-computer route and the explicit Add route.
The mobile unit suite passes 236 tests and the all-project typecheck passes.

The iPhone 17 simulator regression passed (59.5 seconds, zero failures) using
two isolated encrypted fixtures. It pairs both computers, switches from the
offline banner to the working computer and sends a recorded fixture message,
selects the offline computer again, restarts the app, switches without deleting
either saved record, and revokes one computer before successfully using the
other. Result bundle: mobile/uitests/build/mobile-offline-2026-09-08-v6.xcresult.
Pairing automation waits for Connect to mount before opening a pairing link.

The updated iOS internal preview finished successfully at 2026-09-08 10:41 UTC:
https://expo.dev/accounts/yasserd99/projects/shahi/builds/ab3a5600-5781-484b-946b-bee716ca05cb
Install QR: test-results/mobile-offline-2026-09-08/install.png. This replaces
the earlier preview above and includes the native disconnect fixes.
