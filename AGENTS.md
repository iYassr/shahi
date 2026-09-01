# Working on Shahi

A phone-shaped view of a running [herdr](https://herdr.dev) session. `README.md`
says what it is for a user; this says what an agent working on it needs to know
before changing anything.

## The shape of it

```
shared/    the wire contract, types only — both clients import it
server/    Bun sidecar: owns herdr's unix socket, speaks HTTP + WebSocket
mobile/    the Expo app — the product, and where new work goes
web/       the React PWA, archived: kept working, no longer developed
e2e/       Playwright, against a stub of the server
```

One command to a running install: `bash install.sh` (idempotent; upgrades in
place and keeps your passcode). Building the iOS app needs a Mac — see
`docs/on-a-mac.md`, which is also where the iOS tests are free rather than
behind a paid EAS plan.

```sh
bun test shared/src server web/src        # unit
bun run test:e2e                          # both engines, against the stub
bun run test:e2e --project=ios            # WebKit only — what the phone runs
bun run build:web && systemctl --user restart shahi   # deploy
```

**Rebuild and restart after touching `web/`.** The server serves
`web/dist`, so an unbuilt change is invisible and you will chase a ghost.

## How to build here

These govern every change, and they outrank anything below that disagrees with
them.

- Do not preserve backward compatibility. Remove obsolete paths instead of
  adding compatibility layers, fallbacks, or migrations.
- Choose the simplest implementation that fully meets the current
  requirements. Avoid speculative abstractions, configuration, and
  indirection.
- Grow the system in layers. Start from the smallest version that works end
  to end, and add each new capability on top of a product that already
  works. Never trade a working product for unfinished complexity.
- Keep components modular and concerns clearly separated.
- Prefer established, well-maintained libraries when they reduce overall
  complexity or improve reliability. Do not reimplement common
  functionality without a clear reason.
- Lean on the dependencies already in the project before writing your own
  implementation or adding packages. Do not assume a library lacks a
  capability without checking its documentation and types.
- Make architectural decisions for the long term. Do not accept a stopgap
  that only works for now and is meant to be replaced later.

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
  every Codex pane exactly its 36 — it draws on the alternate screen,
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

**The reader is fed by the agent's own transcript, not the terminal.** Codex
Code writes JSONL to `~/.Codex/projects/`; codex keeps a rollout file indexed in
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

- **Native push is untested end to end — but the code is complete.** The whole
  path is wired: a Settings toggle calls `enablePush()`, which registers an Expo
  token with `/api/push/expo`; the server sends on the transition to `blocked`
  and drops `DeviceNotRegistered` tokens; the agents screen routes a tapped
  notification to its pane. What is missing is not code but a device: the
  simulator returns `Device.isDevice === false` and refuses to mint a token, so
  the only place this can be proven is a real iPhone. `expo_push_token` is still
  empty; the first token to land there is the proof. Do not go looking for
  missing wiring — flip the toggle on the phone. Expo receipt polling (dropping a
  token whose failure only shows in the receipt, not the ticket) is deliberately
  not built: it is premature for a table with zero rows, and the common
  invalid-token case is already handled at ticket time. See
  `docs/notifications.md`.
- **The native app's automated coverage is thin but no longer zero.** `mobile/`
  has twelve unit suites (the libs: `reconcile`, `feel`, `api`, `ssh`,
  `tunnel`, `push`, `navigate`; the components: `blocks`, `new-agent`,
  `markdown`, `error-boundary`, `copy`) and seven Maestro flows in `.maestro/`
  that drive the real app against the stub. `web/` still has 164 browser tests,
  so the reader and the poller are still largely proven by hand. Closing that
  gap is the largest remaining test debt now that this is the product. One
  seam was moved to make the SSH and push tests possible: `push.ts` loads
  `expo-notifications` with an inline `require` rather than `import()`, which
  Metro defers identically and Jest can actually execute.
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

## The two clients

**`mobile/` is the product.** August 2026: a paid Apple account made a real
build possible, and the decision followed that native is where this goes —
voice dictation and anything else that needs the device properly are not things
a web page does well.

**`web/` is archived, not deleted.** It still builds, still passes its 164
tests, and the server still serves it, which is worth keeping: it is how you
reach a session from any browser without a build, and it is the reference for
behaviour the native app has not caught up on yet. It should not gain features.
When the two disagree about how something should work, the native app is right
and the PWA is history.

That split has a cost that was already paid once. Every change between January
and August landed only in the PWA, so the native app arrived on the phone
missing agent permission modes, the file viewer, `AskUserQuestion` cards and
the context above a prompt — the last two meaning a codex approval showed as a
bare question with nothing to judge it by. All four are ported. The lesson is
cheap to state and was expensive to find: **a feature that only exists in
`web/` does not exist.**

Still only in the PWA, and worth porting when someone next needs them: the
redesigned agent list and the spaces view. The reader's jump-to-latest pill
is ported.

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

The rename came with a `HERDRUI_DATA` fallback, a startup warning about the old
directory, and an installer that moved it. All three are gone: the only
installation there has ever been was carried across, and code that exists to
bridge a rename nobody else lived through is exactly the debt the rules above
forbid. If a pre-rename backup ever turns up, move
`~/.local/share/herdrui` to `~/.local/share/shahi` and rename the database
inside it by hand.
