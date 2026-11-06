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

- Simulator pass, blocked: run `sudo xcodebuild -runFirstLaunch` (simulator
  framework 1174.9.2, Xcode expects 1174.21). Then `e2e/native/` and
  `docs/verify-on-device.md`, including the connect dead end and dictation.
- Known gap: leaving during the relay claim round trip still selects the new
  computer (`connect.tsx`); it needs a session action to save without selecting.
- Dictation's native states (second install after Cancel, "already running"
  during a finish) were reported but not changed: Swift needs a simulator.
- Left as low value: stale event against a snapshot can send a second push;
  incident reminders pause while their analytics source is down.
