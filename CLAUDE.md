# Working on HerdrUI

A phone-shaped view of a running [herdr](https://herdr.dev) session. `README.md`
says what it is for a user; this says what an agent working on it needs to know
before changing anything.

## The shape of it

```
shared/    the wire contract, types only — both clients import it
server/    Bun sidecar: owns herdr's unix socket, speaks HTTP + WebSocket
web/       the React PWA the phone actually runs
mobile/    an Expo app, complete but unused — see "the native app" below
e2e/       Playwright, against a stub of the server
```

One command to a running install: `bash install.sh` (idempotent; upgrades in
place and keeps your passcode).

```sh
bun test shared/src server web/src        # unit
bun run test:e2e                          # both engines, against the stub
bun run test:e2e --project=ios            # WebKit only — what the phone runs
bun run build:web && systemctl --user restart herdrui   # deploy
```

**Rebuild and restart after touching `web/`.** The server serves
`web/dist`, so an unbuilt change is invisible and you will chase a ghost.

## What herdr actually does, as measured

The docs are wrong in places. These were established against herdr 0.7.5,
protocol 17, and every one of them cost an afternoon.

- **One response per connection.** The socket API closes after answering, though
  the docs describe persistent connections. Open one socket per RPC. The single
  exception is `events.subscribe`, which streams.
- **`revision` cannot detect output changes.** It tracked structural changes
  only: four polls returned `revision: 0` while the text changed. Hash the text
  yourself.
- **There is no scrollback.** `lines` is ignored; `pane.read` returns the visible
  screen and nothing else. The server records its own transcript for the History
  tab.
- **Output cannot be re-flowed.** `recent_unwrapped` returns the same hard-wrapped
  146 columns, because agents wrap before the bytes reach the PTY. So: render
  faithfully and let the user scale, never re-wrap.
- **herdr does not expand `~`.** It silently uses `$HOME` instead, so a display
  path lands every new space in the wrong folder. Always send absolute paths.
- **Key names are strict.** `shift+tab` is accepted, `S-Tab` is not — it answers
  `invalid_key`. Every name in the key bar has been sent to a live pane.
- **Agent detection needs an interactive shell.** `bash -lc` found 2 of 4;
  `bash -ic` finds 4, because `~/.bashrc` is where nvm and friends live.
- **`agent.start` races the shell it needs.** The pane exists before its shell
  does, so starting immediately fails with `agent_pane_busy`. The server owns
  the retry (`startAgentInTab`), and clients call one route.

## Decisions worth not relitigating

**The reader is fed by the agent's own transcript, not the terminal.** Claude
Code writes JSONL to `~/.claude/projects/`; codex keeps a rollout file indexed in
SQLite. Reading those is what makes a phone-shaped conversation possible at all —
terminal text arrives pre-wrapped at 146 columns and cannot be reflowed. The
terminal is still there, on the Screen tab, for when you need the real screen.

**Unknown shapes are dropped, never guessed.** The codex reader reads only
`event_msg` records; an unrecognised type renders nothing rather than something
invented. Same for the prompt parser: no confident parse means the raw terminal
and a free-text box, which is a far better failure than answer buttons for a
question nobody asked.

**The prompt parser requires exactly one cursor.** An agent writing a numbered
list in prose is common; a rendered menu always has its cursor on exactly one
row. Without that rule the dashboard offers to answer prose.

**Full control, gated by a passcode.** `pane.send_text` is arbitrary shell
execution as you, so a method allowlist was never the boundary. The boundary is
network reach (tailnet only) plus the passcode. Given that, file reads are scoped
to `$HOME` and `/tmp` for tidiness rather than security.

**Never log `pane.read` output.** It contains whatever is on your terminals.

**The mirror is re-snapshotted every 3s.** Events alone drift: `pane.updated`
does not report status transitions, and 18 of 18 panes were wrong after a few
minutes of events-only updates.

**Polling is adaptive and priority-ordered**: 400ms watched, 2s active, 15s
background, and watched panes sort first. It backs off entirely when no client is
connected, so a sleeping phone costs nothing.

## Things that only appear on a phone

Each of these was reported by a person, not caught by a test, and the tests that
now cover them are named after the symptom.

- **iOS lays the keyboard over the page**, it does not shrink the viewport. The
  app compensates from `visualViewport` — but only when a keyboard is genuinely
  open. Reacting to every `visualViewport` change meant Safari's collapsing
  toolbar resized the app mid-flick, which felt like the page fighting your
  finger.
- **A `translateY(0)` is still a transform**, and a transformed ancestor changes
  how everything inside it scrolls. The compensation is applied only while the
  keyboard is open.
- **iOS does not reliably deliver taps to non-interactive elements.** An
  `onClick` on an `<img>` works everywhere except the phone. Use a button.
- **WebKit renders a `<button>` through a box of its own**, and an image inside
  one collapses to nothing without `appearance: none` and explicit sizing.
- **`Notification` does not exist on iOS outside an installed app** — touching it
  threw during render and left a blank page in every Safari tab.
- **A service worker bypasses `page.route`.** In WebKit, completely. This is why
  the suite blocks service workers and why a fuse fails any write that leaves for
  a host other than the stub: mocked writes once reached real agents.

## Rules with reasons behind them

Break one of these and the app regresses quietly, which is the worst kind.

**The service worker caches the shell and never `/api`.** A cached dashboard
would show agent states that are hours old, and a stale agent list is worse than
an honest failure. Assets are hashed, so they are cached forever; the HTML is
network-first with a 1.5s grace, because cache-first means every deploy takes two
launches to appear. It precaches the HTML *and* the bundle that HTML names —
without the second part, the first visit cached a page whose JavaScript was not
there, and going offline produced a blank screen.

**The app compares its own bundle against the served one** whenever it comes to
the foreground, and reloads if they differ. A home-screen app is resumed far more
often than launched — iOS keeps one alive for days — so without this a fix can go
unseen indefinitely, and every conversation turns into "are you sure you
reloaded?".

**The reader polls the tail, not the page.** Only the last message can change, so
a poll asks for ~12 messages and `merge` keeps the rest. With an ETag on the
endpoint, an unchanged conversation costs 224 bytes on the wire instead of 15KB
gzipped — and it polls every 2.5 seconds, forever, on whatever connection the
phone is on.

**Everything text-shaped is gzipped at the edge of the request handler**, in one
place, with compressed bytes cached for immutable assets. Nothing was compressed
at all until it was measured: a cold launch pulled 640KB.

**Never re-render the conversation when nothing changed.** The poll compares a
signature and returns the same array identity if it matches. A quiet session was
otherwise rebuilding the entire reader, images and all, on a timer — which is
most of what made it feel unsteady.

**Callbacks passed to components that poll must be stable.** `onUnavailable` was
inline once; the pane re-renders on every frame, so the reader's polling effect
was torn down and rebuilt every 400ms, refetching the transcript each time.

## What is not done

Stated plainly, because a vague gaps list is worse than none.

- **Native push is untested end to end.** The server channel and the client
  registration are both written and unit-tested; nothing has ever delivered a
  notification to a real device through them, because that needs a development
  build and a paid Apple account. See `docs/notifications.md`.
- **The refresh problem is not root-caused.** The owner reports needing to
  refresh the page; two plausible causes were fixed (a render crash with no
  boundary, and a WebKit-only crash on `Notification`) and neither is confirmed
  to be *the* one. If it recurs, what matters is which of three shapes it takes —
  blank, frozen-with-stale-data, or claiming LIVE while not updating.
- **Codex tool calls are unrendered.** `codex-log.ts` reads only `event_msg`
  records and drops unknown types rather than guessing. No sample of a codex tool
  call has ever been captured, so nobody knows what is being dropped.
- **There is no CI.** The suite runs when someone remembers. Everything needed is
  a `bun test` and a `bun run test:e2e` away from being automatic.
- **WebKit is not Safari.** It is the closest thing available on a Linux box and
  it has earned its place, but the phone remains the only place some faults
  appear. `docs/verify-on-device.md` is the five-minute list of those.

## Testing

The suite runs against `e2e/stub/server.ts`, which speaks the same contract with
no herdr behind it and records writes instead of performing them. Tests choose a
situation rather than waiting for one:

```ts
await scenario(page, "waiting");   // three blocked agents, every run
await scenario(page, "empty");     // nothing running
await scenario(page, "crowded");   // twenty-eight agents
```

Two engines, both required: Chromium is fast and catches logic, WebKit catches
what the phone would. A handful of read-only checks run against the real server
behind `--project=live`, because contract drift is the one thing a stub cannot
notice.

**Never point the suite at the live server for anything that writes.** That
mistake typed into somebody's session once already.

## The native app

`mobile/` is a complete Expo app — agents, spaces, reader, screen view,
attachments — verified on an Android emulator. It is unused because Expo Go on
the owner's phone tops out at SDK 54 while the app is on 57, and a real build
needs an Apple developer account. The PWA does everything it does, plus
notifications. Do not delete it; do not assume it is current either.

## House style

Comments explain **why**, and especially why something is not the obvious
alternative. A comment restating the code is worse than none. When a fix comes
from a measurement or a failure, say so in the comment — the reasoning is the
part that decays fastest and is hardest to recover.

Commit messages are prose, not bullet lists of changed files: what broke, how it
was found, what it cost.
