# Pre-publication review, 13 November 2026

Asked: does it support the newest agents, does everything pass, can it take
launch traffic. Run on macOS at `203f3c6` plus the state-machine commits below;
nothing is pushed.

## Done

- Agents installed: Claude Code 2.1.323, codex-cli 0.167.2 (daemon 0.169.0),
  Cursor 2026.10.22 on the Mac and 2026.11.11 on Linux, OpenCode 1.19.5 and
  2.2.0, Antigravity 1.5.7, herdr 0.9.5 (protocol 22, current stable)
- Transcript census clean on both computers after three new decisions
- Screen census: three reworded screens refreshed, all still cards
- Cursor 2026.11.11: slow trusting screen, moved store.db, both journeys pass
- Reader's own read over the Mac's transcripts from 2.1.317 to 2.1.323: four
  transcripts, 125 messages, no failure
- `bun run typecheck`, `bun run test` (2,085 pass), relay 139, mobile 787,
  browser 424, hosted 76, PWA 44, dashboard 18; relay load 1,000 pairs passed
- Public site, PWA, installer (herdr 0.9.5), relay health and App Store 1.1.4
  answered; this Mac's service is 0.3.36 and connected
- Simulator pass, 14 November: a Release build of 1.1.4 from this tree on an
  iOS 27 simulator, `mobile/uitests/run.sh` without `PhoneTests`: all 12
  passed. The simulator works again with no first-launch step. The first run
  failed four tests because the simulator's keychain still held an unreachable
  computer from an earlier session, which `signOutEverywhere` cannot leave;
  `simctl keychain <udid> reset` and a reinstall cleared it. The build needs
  `LANG=en_US.UTF-8` (CocoaPods) and `SENTRY_DISABLE_AUTO_UPLOAD=true` (no
  Sentry token on this Mac), and a prebuild first: `mobile/ios` was 1.1.0.

## Next

- herdr's agent hooks were removed from both computers in the 2 November
  cleanup, and the hourly journeys failed for Claude and OpenCode from then on
  ("session not reported"). The owner had them reinstalled on the Mac on
  14 November (`herdr integration install`; the settings as they were are in
  `~/.claude/backups/herdr-rehook-2026-11-14`). Journeys on the Mac then
  passed: Claude Code 2.1.325 both ways, Codex 0.167.2 started by Shahi (by
  hand is skipped while the owner's shared daemon runs), Antigravity 1.5.8
  both ways. **Ubuntu is still unhooked**: run the five installs there, or its
  hourly run keeps failing for Claude and OpenCode 2.2.0.
- Issues 59, 61, 62, 65 and 69 are still open; 62 and 65 are answered by the
  census commit, 69 is stale (the service is connected).
- Not run here: `reader-parity.ts` on live panes, OpenCode's journey on the
  Mac (left out by `mac.skip`), the herdr live suite, the Maestro flows, CI. The owner's policy runs CI at a release.
- Codex's update offer cannot be drawn on a Mac standalone install; draw it on
  Linux before a release.
- The review computer's `REVIEW_EXPIRES_AT` is 31 December 2026.

# State-machine review, November 2026

Fixes from a review of the app's implicit state machines. Most have a test named
after their symptom. Without one: the notification alert, the web Attach switch,
the phone's upload folder, its reader pill after flipping views, the chosen note,
the Working backstop, the review controller and the dashboard wording. Commits
are local until the owner asks to push.

## Done

- `/answer` no longer presses twice after a reply that never came
- Connect: host-key review cannot be stranded; cancelling stops a late sign-in
- Update journal has a direction; a stopped manager gives no verdict; a failed
  release is remembered; outcomes survive a manager replacement
- `ControlSession.pending` cannot stick
- Composer: dictation during a send, uncertain chip after Back, web typing
  during a send, new occupant never gets old words back
- Uploads: stranded finalizing transfers complete; moving folders do not abort
- Native socket: one live connection, guards ported from web
- Prompt tracking and poller: no blinding after forget, older reads give way
- Web pairing: superseded claims kept, fresh links open their card
- Relay: a hello after waiting has a deadline
- Claude choice, plan usage races, slow agent starts, push token on switch,
  unanswerable notification answers, reader following and pill on both clients,
  new-space wait, review controller startup, dashboard wording

## Next

- The XCUITest suite passed on 14 November (above). Still to do by hand:
  `e2e/native/`, the Maestro flows and `docs/verify-on-device.md` on a phone,
  including the connect dead end and dictation.
- Known gap: leaving during the relay claim round trip still selects the new
  computer (`connect.tsx`); it needs a session action to save without selecting.
- Dictation's native states (second install after Cancel, "already running"
  during a finish) were reported but not changed: Swift needs a simulator.
- Left as low value: stale event against a snapshot can send a second push;
  incident reminders pause while their analytics source is down.
