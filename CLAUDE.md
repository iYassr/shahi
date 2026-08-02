# Working on Shahi

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
bun run build:web && systemctl --user restart shahi   # deploy
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
- **Scrollback depends on the source, and this was wrong here for months.**
  `source: "visible"` is the current screen and ignores `lines` — which is where
  "there is no scrollback" came from. `source: "recent"` returns the last N of
  the pane's *total* rows, scrollback included, capped at 1000 server-side.
  Measured live: a shell gave 268 rows against 36 visible, a codex pane 196, and
  every Claude Code pane exactly its 36 — it draws on the alternate screen,
  where no rows exist behind the ones you can see. The poller reads `visible`
  every tick and `recent` once per pane, to seed history from before it was
  watching; the recorder builds the rest.
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
SQLite. herdr hands over the id to join on — but for codex only once its
integration is installed (`herdr integration install codex`), which adds the
SessionStart hook that reports one. Without it the reader falls back to asking
`/proc` what file the codex process has open, and then to the working
directory, which cannot tell two sessions in one folder apart.

Reading those files is what makes a phone-shaped conversation possible at all —
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

**The reader reads a window, not a file.** A transcript is indexed once by the
byte offset of the line that produced each message — two numbers per message
against a parsed object — and a poll reads only that byte range. This replaced
parsing the whole JSONL to slice twelve messages off the end, which had gone
from reasonable (4.9MB, 516 messages) to 208MB of resident memory per pane
opened (38MB, 2,391 messages). Measured after: a six-pane sweep costs 111MB
where it cost 369MB, and re-polling a pane you opened earlier costs 1MB where it
cost 154MB. Two properties of `normalise` make windowing sound and both are load
bearing: whether a row produces a message depends on that row alone, and an
orphaned `tool_result` already renders nothing rather than something wrong.

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

**A dead stub is reported as a dead stub.** Every test takes the server's pulse
before it runs and again if it failed, because a run once produced one real
failure followed by 78 connection errors and nothing said which was which. Now
the first test to find the server gone fails saying so, and the rest are skipped
— they did not run, and calling that 78 regressions is worse than saying
nothing. The marker is a file (`e2e/.server-gone`, cleared by `global-setup.ts`)
because Playwright replaces the worker process after a failure and module state
goes with it.

CI runs all of this on every push and pull request: `bun run typecheck` — which
includes the parked Expo app, the only automatic check that the two clients have
not drifted apart — then the unit tests, then a web build and both engines.
Traces from a failing run are uploaded as an artifact.

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

## The name

This was HerdrUI until August 2026, and is now **Shahi** — because a phone-shaped
window onto a terminal multiplexer need not be named after one multiplexer, and
tmux is a plausible second backend.

Two things kept the old name deliberately:

- **`server/lib/herdr-*.ts`** is the herdr adapter, and should stay called that.
  When a second backend arrives it wants a sibling, not a rename.
- **`server/fixtures/`** contains captured terminal output, and some of those
  screens have `/home/yasserdo/HerdrUI/…` in them because that is the path that
  was on screen when they were recorded. Rewriting a recording to match a later
  decision makes it a worse record. They were rewritten once by a careless
  find-and-replace and restored.

`HERDRUI_DATA` is still read as a fallback, and the installer moves
`~/.local/share/herdrui` to `~/.local/share/shahi` on the first run after the
rename. Startup says so loudly if it finds the old directory and no new one,
because an empty database beside a full one looks exactly like a quiet app.
