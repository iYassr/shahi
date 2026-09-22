# Ten minutes on the actual phone

The native app has Jest component/unit coverage and Maestro simulator flows,
but neither can prove behavior that exists only in a signed binary on physical
hardware. This checklist is the release-candidate complement to automation: it
covers APNs, camera behavior, haptics, Keychain upgrades, radio changes,
assistive technology, and actual touch ergonomics.

It is ordered by what is most likely to be broken, not by what a user does
first. Anything a type checker cannot confirm — a route, a native module, a
gesture, a notification — is near the top.

## Before you start

Record the app version/build, iOS version and device model. Confirm the
installed release contains the change being checked. Use a dedicated test
computer/session for writes, not an existing customer conversation.

**Every change needs a new build.** Updates are not delivered over the air —
the app never calls `expo-updates` — so a JS-only fix reaches the phone the same
way a native one does. Backgrounding and reopening changes nothing.

## The checks

**1. It opens, and it opens where it should.**
Cold-launch from the icon with the network on. You should land on the agent
list. Force-quit and reopen in airplane mode: it should say it cannot reach the
server, not hang and not show an empty list as though nothing were running.
Sign out and back in — scanning a fresh code should land you back on the list.

**1b. SSH mode still reaches loopback.** The one thing only a device answers:
ATS is narrowed to `NSAllowsLocalNetworking`, so the tunnel's
`http://127.0.0.1:<port>` is the only cleartext the app is permitted. Connect
over SSH on a real iPhone and read a pane. A simulator does not enforce ATS the
same way, so this cannot be proven anywhere else.

**2. The tab bar is real.**
Tap between Agents and Spaces. The bar should blur what scrolls under it, and
tapping the tab you are already on should scroll that list back to the top.
Neither is something a drawn tab bar can do, which is why it is here.

**3. Nothing hides under the notch or the home indicator.**
Scroll each list to both ends. The first row should clear the status bar and the
last should clear the home indicator, and the scroll bar itself should stay
inside the safe area.

**4. Starting an agent offers its permissions.**
Spaces → a space → New agent. Pick claude: four modes should appear, from "Ask
me" to "Skip all permissions", the dangerous one outlined in red. Pick codex:
the four should change to codex's own. Start one with a non-default mode and
confirm on the desktop that the flags actually landed — this is the one thing on
this list where being wrong is expensive rather than annoying.

**5. A question renders as a question.**
Find a blocked agent. The card should carry the question, the numbered options,
and — for codex — the command it wants to run above them. If you see a bare
"Allow?" with nothing to judge, the context lines are missing.

**6. A file a tool touched opens.**
In a transcript, find a tool row naming a file and tap the filename. Text should
open in a sheet; an image should open as an image. There is deliberately no
download button.

**7. It taps back.**
Answering a prompt, sending a message, and starting an agent should each give a
small haptic at the moment it commits. A failure should feel different from a
success. If you feel nothing at all, `expo-haptics` did not make it into the
build.

**8. Text you want is selectable.**
Long-press a paragraph the agent wrote, a code block, and tool output. All three
should offer Copy. Chrome — titles, labels, the tab bar — should not.

**9. The keyboard does not bury the composer.**
Open a pane, tap the text box. Composer, key bar and Send stay above the
keyboard. Type, dismiss, reopen: the draft survives. Rotate with the keyboard
open and the composer is still reachable.

**10. Notifications arrive.**
Turn them on. `device_expo_push_token` on the server should gain an owned
registration; until it does, nothing else in this check can pass. Then
lock the phone, get an agent to block, and confirm one arrives. Tap it: it
should open that pane, not the list.

**11. Customer journeys survive interruptions.**
Type a draft, open another conversation, and return. Switch computers, including
ones with matching pane IDs, and check drafts stay separate. Background and
resume without killing the process. Reload/process termination is allowed to
clear drafts; do not count that as navigation loss.

Create an agent from both Agents and Spaces with a readable name containing
spaces. It should open its own conversation without a false “gone” message.
Interrupt the network after sending and retry only through the existing UI;
confirm the dedicated test command ran once. Test a multi-file browser batch
across interruption and verify only the remaining files are retried.

On a real phone, switch between Wi-Fi and cellular, revoke its temporary
access, and confirm the app exits that computer while another saved connection
remains usable. For the PWA, install from Safari, reopen offline, then reconnect.
Check Read/Screen, Back and Live controls in light and dark appearance, larger
text, VoiceOver and Reduce Motion. Camera, dictation and push delivery need
physical-device evidence; simulator success is not a substitute.

## What to write down when something fails

Which of these it is, because they point at different things:

- **crash on launch** — a native module in the JS but not in the binary. Almost
  always means a rebuild was needed and an update was pushed instead.
- **blank screen, app still responsive** — a render threw.
- **the screen is right but the data is old** — the socket died; the mirror
  re-snapshots every 3s, so this should not persist.
- **it says connected and nothing updates** — server-side.

A screenshot beats a description. `~/.local/share/shahi/uploads` is a fine place
to put one — the app can then show it to whoever is debugging.

- Swipe an Agents row left: Pin and Screen appear and answer a real
  finger. The suite cannot press buttons inside the swipe gesture area, so
  the swipe path is checked here; the long-press sheet covers it in CI.

- Tap an agent row immediately after opening the app from a killed state:
  under the dev client the very first touch can be swallowed before it
  reaches the app (measured: the press handler never fired), and a second
  tap works. Confirm a release build on the phone does not do this.
