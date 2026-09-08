# Web computer switching — September 8, 2026

The hosted browser app at `/pwa/` now offers Settings → Computers → Switch or
add a computer. Saved computers are also available from pairing and offline
screens. Switching closes the previous relay and clears reader state and
navigation without revoking its device grant. Pins and notification-dismissal
preferences are scoped to the computer. Sign-out and revocation remove only the
selected pairing, preserving the others.

The browser's existing consent model remains: unchecked “Remember this browser”
keeps credentials in process memory only. Checked pairings live in IndexedDB.
Remembered computers survive reload even when the last active connection was
temporary. The selected remembered connection restores automatically. Pairings
replaced by previous releases need one new code; their deleted secrets cannot be
recovered from server device listings.

Validation: all-project typecheck; 576 shared/server/web/plugin unit tests;
24 hosted browser tests across Chromium and iPhone WebKit. The new tests pair two
independent encrypted fixtures, switch A/B, prove messages went only to the
selected fixture, reload, return to the other computer, and sign out independently.
A mixed remembered/temporary test verifies that reload drops the temporary
computer without deleting the remembered one. Browser Harness also inspected the
new screen in an isolated Chromium instance.

The snapshot test caught and fixed an initial-subscription race: authentication
can open the relay before the dashboard subscribes. The app now fetches the
initial session explicitly instead of depending on catching that first push.
Direct same-origin server pages still connect to the server whose URL was opened;
this computer list belongs to the hosted relay app.

The broader web suite initially recorded 178 passes, 4 skips, four assertions
against the renamed Settings heading, and two WebKit stress-test timeouts. After
updating those heading assertions, the focused rerun passed all 9 selected tests
(including setup and both engines' memory/terminal checks). No timeout increase
or production-code workaround was needed for the stress checks. The final hosted
suite passed all 24 tests again, and the final typecheck passed.

Published to https://getshahi.dev/pwa/ with Cloudflare deployment
`7f071c59-3d38-4408-8f80-3ced3f4d0535`. Browser Harness verified the public pairing
page loads and serves the new `index-HufT0adh.js` bundle matching the local build.

## Disconnect follow-up

A selected saved pairing now opens independently of network authentication;
server availability appears as an offline status rather than returning to QR
onboarding. Computers is always reachable above the dashboard, including while
offline and on a phone-sized viewport. When access ends and other pairings remain,
the saved-computer list opens directly. The QR form opens only for an explicit
Add a computer action, incoming pairing code, or an empty list.

Automatic version reloads now require every retained computer to be remembered,
so selecting a remembered computer cannot silently discard another temporary one.

Validation: 28 hosted tests passed in Chromium and iPhone WebKit; 111 web/shared
unit tests and the all-project typecheck passed. New tests hold a server offline,
reload, switch to the other saved server, return when it is online, revoke it,
and switch again without using a QR code. A separate test proves that discovering
an update preserves a temporary second computer. Browser Harness confirmed the
Computers control remains within a 390×844 phone viewport during disconnection.

Disconnect fix deployed as `943c5863-2e11-4bb1-b660-6202bc365250`; the public
browser page was verified to serve the matching `index-C9vEFMPh.js` bundle.
