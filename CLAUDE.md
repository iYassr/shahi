# Working on Shahi

A phone-shaped view of a running [herdr](https://herdr.dev) session. `README.md`
says what it is for a user; this says what an agent working on it needs to know
before changing anything.

## The shape of it

```
shared/    the wire contract and the end-to-end crypto — both clients import it
server/    Bun sidecar: owns herdr's unix socket, speaks HTTP + WebSocket
plugin/    the herdr plugin: startup hook, actions, the service it installs
relay/     the blind relay: a Cloudflare Worker, one Durable Object per box
mobile/    the Expo app — the product, and where new work goes
web/       the React PWA: mobile behavior with responsive phone/laptop layouts
e2e/       Playwright, against a stub of the server
```

`herdr-plugin.toml` at the root is how the sidecar is distributed: `herdr
plugin install iYassr/shahi` (see `docs/plugin.md`), and the only way — the
older `install.sh` was deleted once the plugin covered both platforms.
Building the iOS app needs a Mac — see
`docs/on-a-mac.md`, which is also where the iOS tests are free rather than
behind a paid EAS plan.

```sh
bun run test                              # unit, workflow policy and dependency checks
bun run test:e2e                          # both engines, against the stub
bun run test:e2e --project=ios            # WebKit only — what the phone runs
bun run build:site && bun run test:hosted && bun run test:pwa # public PWA, encrypted fixtures and real cache
bun run build:web                         # what a development server serves
```

`bun run test` is the canonical unit command (package.json's `test`); it also
runs `./.github`, the workflow-policy and herdr-installer tests. The `./` is
load-bearing: `bun test` skips dot-directories unless a path names one, so
`.github` without it silently matches nothing.

**Rebuild after touching `web/`.** Development servers serve `web/dist`.
Managed production services serve the web assets inside their approved release;
publish and install a release to change those. See `docs/releases.md`.

## How to build here

These govern every change, and they outrank anything below that disagrees with
them.

- Preserve the supported Shahi API contracts: current and previous generation,
  with at least 90 days after the successor's stable release before retirement.
  The security floor is API 5 and encrypted transport 2; never restore older
  unsafe protocols. Additive features negotiate capabilities. herdr differences
  belong in the server adapter. See `docs/releases.md` for the release policy.
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
protocol 17, re-checked against 0.8.2, protocol 20, and every one of them cost
an afternoon. They are now also asserted by `server/lib/herdr-live.test.ts`
against a real herdr on every push — 0.9.0 and 0.9.1, protocol 22, and
whatever is current (see Testing) — so the next drift is a red job rather than
a report from a phone.

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
  `bash -ic` finds 4, because `~/.bashrc` is where nvm and friends live. A
  slow profile must not freeze the sidecar, so discovery is asynchronous
  (`Bun.spawn`) with a 10s timeout that SIGKILLs the shell (an interactive
  shell ignores SIGTERM); callers that arrive together share one shell, and a
  killed shell's empty answer is not cached.
- **`agent.start` races the shell it needs.** The pane exists before its shell
  does, so starting immediately fails with `agent_pane_busy`. The server owns
  the retry (`startAgentInTab`), and clients call one route.
- **`agent.prompt` refuses a blocked agent.** herdr's own semantic submit
  (protocol 20) is how a prompt reaches an agent — one call, no paste delay,
  herdr drives the composer. But "if the agent is already blocked, submission
  is rejected with `agent_blocked` before any input is sent", and a blocked
  agent is exactly the one you type a free-text answer into. So `prompt.ts`
  sends blocked agents, shells and unknown programs the terminal sequence —
  `pane.send_text`, 200ms, Enter — and falls back to it if herdr answers
  `agent_blocked` under a stale status. The 200ms is measured: codex's composer
  drops Enter that arrives too soon after pasted text (150ms sufficed).
  Before typing at an agent that way, `prompt.ts` reads the visible screen: if
  the prompt parser finds a menu whose highlighted row is not a text field,
  nothing is typed and `/api/panes/:id/prompt` answers 409 `prompt_open`.
  Measured on Claude Code 2.1.280 / herdr 0.9.1 (2026-09-23): at the Bash
  permission menu with the cursor on `1. Yes`, typing "no" then Enter ran the
  command. The text-field rows are `Type something.` (the question tool) and
  `Tell Claude what to change` (plan approval): typed text replaces their
  label and Enter submits it, so those are still typed. `No, and tell Claude
  what to do differently` ignores typing. Shells are unaffected.
- **Claude Code's folder-trust question is an unnumbered menu, and its
  default quits.** `❯ No, exit` over `Yes, I trust this folder`, no digits,
  `Enter to confirm` beneath. Measured on a live pane: a digit does nothing
  there; `up`, `down`, `j`, `k` and the key bar's `Up`/`Down` all move the
  cursor; several keys in one `pane.send_keys` land in order; and herdr reports
  the pane `unknown` for a few seconds after `agent.start` before `blocked`.
  The parser anchors this shape on the confirm hint, and the server walks the
  cursor to answer it (`answer.ts`). A menu read during that `unknown` window
  is kept, and the poller asks herdr's status again on an unchanged screen, so
  the card gains its buttons once herdr says `blocked`; a static menu never
  changes the hash that would otherwise trigger a re-parse.
- **The plugin CLI, measured on 0.9.1.** `herdr plugin list --json` and
  `herdr plugin config-dir <id>` read the registry and work without a server;
  `config-dir` resolves for any id, installed or not. `disable`, `enable` and
  `uninstall` need a running server; `disable` leaves the entry with
  `enabled: false`, and `uninstall` drops it.

## Decisions worth not relitigating

**The reader is fed by the agent's own transcript, not the terminal.** Claude
Code writes JSONL to `~/.claude/projects/`; codex keeps a rollout file indexed in
SQLite. herdr hands over the id to join on — but for codex only once its
integration is installed (`herdr integration install codex`), which adds the
SessionStart hook that reports one. Without it the reader falls back to asking
`/proc` what file the codex process has open, and never guesses from the working directory: a new session must not show
another session’s transcript. On macOS, `lsof` supplies the same exact process-file lookup; installing the
Codex integration also keeps transcripts available after the process exits.
The process-file lookup answers only when the codex process has exactly one
rollout open. With more than one — subagent threads, or a thread still loaded
after `/new` — there is no transcript until herdr reports a session id, which
is the same refusal to guess.

Reading those files is what makes a phone-shaped conversation possible at all —
terminal text arrives pre-wrapped at 146 columns and cannot be reflowed. The
terminal is still there, on the Screen tab, for when you need the real screen.

**Unknown shapes are dropped, never guessed.** The codex reader renders a
fixed set of shapes and nothing else: conversation, reasoning, tool calls, MCP
and web-search activity, and native `apply_patch` edits — an unrecognised type
renders nothing rather than something invented. Since codex 0.151, reasoning,
MCP calls, native edits and web searches arrive only as `item_completed` items
(`Reasoning`, `McpToolCall`, `FileChange`, `WebSearch`); the legacy events are
still read for old rollouts. The `exec` row that wraps a native edit or MCP
call deliberately stays beside the item: items carry no call id to join on,
and a failed patch emits no `FileChange`, so the exec row is the only record of
that failure. Other item types (`CommandExecution`, `ImageView`,
`ContextCompaction`, anything new) stay dropped. Codex user messages that are
really `<task-notification>` reports, `<send_user_message_question_reply>`
answers, or Claude Code's command and `!cmd` tags are unwrapped. The Claude
reader's system-note handler is an explicit allowlist (`SYSTEM_NOTE_SUBTYPES`)
for the same reason: `away_summary` and `model_refusal_fallback` carry text the
person saw, every other `system` subtype is chrome and stays dropped. User rows
flagged `isCompactSummary` — the 14–19KB handoff Claude Code writes after
`/compact` — are dropped like `isMeta` rows; `<bash-input>` renders as
`! <cmd>`, and `<bash-stdout>`/`<bash-stderr>` as its output, with no message
when nothing was printed. Same for the prompt parser: no confident parse means
the raw terminal and a free-text box, which is a far better failure than answer
buttons for a question nobody asked.

Claude Code permission dialogs put the tool and command above a generic
question. When the question sits directly on the options, the prompt's context
is the dialog's block between its full-width top rule (20 or more `─`) and the
question, in screen order, one entry per paragraph, keeping line breaks and
relative indentation; with no rule on screen there is no context.
`AskUserQuestion` cards carry their header row (`☐ Colour`) as context.

**The prompt parser requires exactly one cursor.** An agent writing a numbered
list in prose is common; a rendered menu always has its cursor on exactly one
row. Without that rule the dashboard offers to answer prose. An unnumbered
menu needs more: rows whose labels line up, directly above an `Enter to
confirm` hint — the `❯` glyph alone is the shell's echo and the composer.

**A prompt is answered by the server, against a fresh read of the screen.**
Both clients post the option they showed — index, label, and the question and
context it sat under — to `/answer`; the server re-reads the pane, re-parses,
and only if all of them still match presses the keys — the digit for a
numbered menu, cursor moves and Enter for an unnumbered one. The client's copy
of the screen can be seconds old, a move computed from a stale cursor lands on
the wrong row, and the trust menu's wrong row exits the agent. The question
and context are compared because index and label are not enough: every Claude
permission offers "1. Yes". An older client that sends only index and label is
still answered on those two. A 409 with `prompt_gone` or `prompt_changed` is
the answer when the screen moved on; nothing is pressed.

**Full control, gated by a passcode.** `pane.send_text` is arbitrary shell
execution as you, so a method allowlist was never the boundary. The boundary is
the loopback listener — the bind, and a `Host` allowlist that refuses anything
but `127.0.0.1`, `localhost` or `[::1]` before routing, so a DNS-rebinding page
cannot reach it — plus the passcode, or possession of a paired device's secret
over the encrypted relay. An owner's own reverse proxy (`tailscale serve` for
Web Push) is let through only by naming it in `SHAHI_ALLOWED_HOSTS`, and a
malformed entry stops startup. Missing passcode configuration and non-loopback
binds prevent startup. Given that, file reads are scoped
to `$HOME` and the OS temp directory (`tmpdir()`, which on macOS is
`/var/folders/…` and not `/tmp`) for tidiness rather than security.

**Never log `pane.read` output.** It contains whatever is on your terminals.

**A phone reaches a box two ways, and typing an address is not one of them.**
The relay is the default and pairing is a relay act — a `shahi://pair` code
carries the relay, the box id and a one-time secret, and nothing else. SSH is
the alternative for someone who wants no third party in the path: it opens a
tunnel and points the same HTTP client at `127.0.0.1:<forwarded>`, so it is the
relay's only peer in `dispatch()`. The typed tailnet address that used to be a
third option is gone (2026-09-04): it was never a transport of its own — SSH
rides on the very code path it used — and keeping it meant a second pairing
route, an exposed bind, and an `NSAllowsArbitraryLoads` to defend. A box with
`RELAY_URL=` empty now mints no codes and is reached over SSH with the passcode.

**Both clients speak Shahi routes, never herdr methods.** `POST
/api/panes/:id/prompt`, `/answer`, `/keys`, `/api/workspaces`,
`/api/agents/start` — the sidecar translates, so a herdr rename or a change in how a prompt is submitted
never reaches an App Store binary that cannot be updated on the same day.
`/api/rpc` still exists for debugging; neither app may call it — and cannot: the server answers 403 to any
request carrying `x-shahi-api`, which every app request does.

**The app and the sidecar negotiate a contract version.** `SHAHI_API_VERSION`
in `shared/` is the number; `GET /api/meta` (unauthenticated) says what the
server speaks, every request carries `x-shahi-api`, and a mismatch is a 426
whose text says which side to update. Both clients map a 426 to
`IncompatibleServerError`: the web client shows "Update needed" with the
server's words and stops its live stream while that notice is up, as the native
app does, and its pane view shows the words instead of retrying. Bump the
number when a route or payload changes in a way an older client would
misread — not for additions.

**The plugin's startup hook installs a service; it is not the service.**
herdr's `[[startup]]` commands are one-shot by contract — "not supervised
daemons" — so `plugin/shahi.ts setup` renders a LaunchAgent or a systemd user
unit, (re)starts it, and exits. The OS supervises the approved manager in the
plugin's state directory. It runs immutable, verified service builds and requests
the newest compatible approved build after a plugin reinstall. Secrets live in herdr's per-plugin config
directory, named by `SHAHI_ENV_FILE`, never in the checkout. The service
follows the socket of whichever herdr ran the hook last. The service's
environment carries `RELAY_URL` (Shahi's relay) unless the `.env` has the
key, because a fresh install that ended at "no address to give a phone yet"
was the whole onboarding problem: with the relay the first QR works from
anywhere. The default is in code, not written to the user's file — on disk it
would be every install's trust anchor for life, and the relay could never
move. `RELAY_URL=` empty means direct-only. herdr 0.8.2, where this was
measured, had no menu for plugin actions (the CLI and a bound key are the ways
in), herdr's notifications are off by default, and `herdr plugin install`
cannot run the startup hook (build commands get no plugin context), so the
`pair` popup runs the setup itself when the service is missing: "install, then
pair" is the whole flow and the first run's output is on a screen a person is
looking at. herdr closes a popup the moment its command exits, so the popup
holds everything it printed until Enter — the passcode and the lingering
warning before the QR, and any failure before it closes. `herdr notification
show` is sent too, without the passcode digits — a toast is every attached
client — and a startup hook that fails is toasted as well, because herdr
ignores its exit status. A lost passcode is replaced by the `reset-passcode`
action, which prints the new one once to the plugin log. `plugin/bun.sh`
installs bun during `herdr plugin install` only. herdr has no uninstall or
disable hook, and the service no longer needs the checkout it deletes, so the
manager asks herdr every 30 seconds whether the plugin is still installed and
enabled for the configuration root it was installed from, and on a "no"
confirmed five seconds later removes its own service. Anything short of a
clear answer leaves it running. The `uninstall` action remains the immediate
path: service first, then `herdr plugin uninstall`.

**A phone is introduced by a code, and can be revoked.** `bun run
server/scripts/pair.ts` prints a single-use, ten-minute code as a QR; the app
scans it, checks the server's identity against the code, and receives a
session bound to a per-device row that Settings can revoke — immediately, on
the next request and on the open socket, and a phone that was offline is told
on its next relay connection by a sealed `bye` keyed from the revoked row's
secret. That is why revoked rows keep their secrets; never delete one without
replacing that mechanism. The passcode stays as the fallback and is not a
device. See `docs/pairing.md`. The security posture of the whole
surface, what was fixed and what is deferred to whom, is in
`docs/security-review.md`.

**A phone reaches a box from anywhere through a relay that reads nothing.**
`docs/relay.md` is the protocol and `shared/src/relay.ts` its shapes. The
box dials out (`RELAY_URL`) and proves an Ed25519 key whose hash is its
`serverId`; phones are multiplexed onto that one socket by link number; and
above the relay every frame is sealed with `shared/src/e2e.ts`, keyed from
the pairing secret or a per-device secret that never travels — the relay
sees connection metadata, sizes and timing; content stays encrypted. `cd relay && bunx wrangler deploy`
runs one; the pairing code carries its address, and the app prefers it.
The plaintext hello proves nothing: a link must send a valid sealed message
within fifteen seconds before the sidecar issues its session or attaches its
stream. Both clients send a sealed watch/unwatch immediately after deriving
device-session keys. Relay controls are bounded and validated before dispatch;
a malformed relay response must never crash local HTTP/SSH access.

Measured: 203ms for a request through Cloudflare's edge, 557ms for a first
hello that wakes a cold Durable Object. Three things learned the day it
first ran, all now in the protocol: the hello is a *binary* frame, because
the relay forwards data and drops phone text; a pairing link may read
`/api/meta` before it claims, because the phone checks the box's id first;
and the box pings, because a Durable Object cannot — a box silent for five
minutes is dropped. The `e2e.ts` construction had its second review on
2026-09-02 (`docs/security-review.md`, R1–R7): the box no longer dies on a
hello with a low-order point, `open` refuses a gap in the counter so a relay
cannot silently drop a frame, an empty pairing secret is refused rather than
degrading to unauthenticated DH, the database is 0600 in a 0700 directory,
and `/api/meta` over the relay names no versions. The relay became the
plugin's default way in with plugin 0.2.0, ahead of an outside review of the
construction, because the relay reads nothing and `RELAY_URL=` opts out; an
outside review would change the envelope, not that default
(`docs/connectivity.md`).

**Logout revokes a session on the server.** Signed cookies contain a random
session nonce; revoked token hashes persist in the sidecar database until expiry.
The running server must supply that database to `Auth`. Offline owner scripts
may still sign short-lived tokens. Browser code delivered by `getshahi.dev` is
trusted with active sessions and remembered secrets; keep the entire origin free
of third-party scripts. Both public Workers disable `workers.dev` and preview
hostnames. See `docs/security-assessment-2026-09-05.md` for the remediation.

**The reader is pushed, and polls only to recover.** While a phone watches a
pane the server watches that pane's transcript file and sends `log_changed`
(size only, no content) the moment it grows; the reader fetches its tail then.
The 2.5s poll stays as the backstop for a dropped socket or a missed file
event. `fs.watch` alone is not enough — it can miss — so a 1s size check backs
it (`transcript-watch.ts`). The watched pane's transcript path is looked up
again every 3s and the watcher moves when it changes — after `/clear`, a new
codex or Cursor session, or a codex process exit — and the move is pushed as
`log_changed`. While no file is found yet, frames trigger an immediate lookup;
a lookup that finds nothing keeps the current watch.

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
- **A FlatList's content size changes while you swipe through it**, as cells
  above the fold get measured for the first time. The reader used
  `onContentSizeChange → scrollToEnd` to follow new output, gated on a
  `following` flag that the throttled `onScroll` only cleared 200ms into a
  swipe — so a swipe up was snapped back to the tail before it had gone
  anywhere. Three swipes, three snaps, and the keep-your-place flow failed
  about one run in three on a loaded machine. A drag now ends following the
  instant it begins (`onScrollBeginDrag`); the position is re-derived from the
  first handled scroll event. Same shape for restoring a remembered place: it
  now ends when the anchor is seen at the top, not on a 1.5s timer that a slow
  measure could outlast.

## Rules with reasons behind them

Break one of these and the app regresses quietly, which is the worst kind.

**The service worker caches the shell and never `/api`.** A cached dashboard
would show agent states that are hours old, and a stale agent list is worse than
an honest failure. Assets are hashed, so they are cached forever; the HTML is
network-first with a 1.5s grace, because cache-first means every deploy takes two
launches to appear. Normal launches were in fact served cache-first from
`dca0e80` until the pre-public-release review, contradicting this paragraph;
they are network-first again. The cache is named after its release: a hash of
every built file, which `web/sw-build.ts` stamps into `sw.js` at build time, so
there is no hand-bumped version constant to forget. Each release precaches
every file it ships, the lazily loaded terminal chunk, the PDF viewer and the
pdf.js worker included (about 2.7 MB uncompressed), because the first visit
once cached a page whose JavaScript was not there, and a page left open across
a deploy could not open the terminal or a PDF. Activation keeps the newest
earlier complete release, for pages still running it, and deletes older ones,
so at most two are cached. A response of type `text/html` is never stored as
an asset: a sidecar answers a missing path with the app's HTML and a 200.

**The app compares its own bundle against the served one** whenever it comes to
the foreground, and reloads if they differ when it is safe to do so. Drafts,
attachments, pending or in-flight sends and uploads, and open dialogs defer the
reload — in every conversation held in the draft store, not only the one on
screen, which is all it checked until the pre-public-release review. A home-screen app is resumed far more
often than launched — iOS keeps one alive for days — so without this a fix can go
unseen indefinitely, and every conversation turns into "are you sure you
reloaded?". A lazily loaded chunk that fails to load shows an in-place "could
not be loaded" notice with Try again; if the server names a newer bundle, the
update banner appears instead of the error screen.

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
  the only place this can be proven is a real iPhone. `device_expo_push_token` is still
  empty; the first token to land there is the proof. Do not go looking for
  missing wiring — flip the toggle on the phone. Expo receipt polling (dropping a
  token whose failure only shows in the receipt, not the ticket) is deliberately
  not built: it is premature for a table with zero rows, and the common
  invalid-token case is already handled at ticket time. See
  `docs/notifications.md`.
- **The native app's automated coverage is thin but no longer zero.** What
  `bun run test:mobile`, the simulator runs in `e2e/native/` (paired through
  the encrypted hosted fixture) and the XCUITest harness in `mobile/uitests/`
  cover is the answer — the counts used to be written here and rotted within
  weeks, so they are not any more. None of the simulator runs is in CI. The reader is now
  proven by `pane.test.tsx` — echo, working state, coalesced refresh,
  concurrent fetches, sign-out on 401, the restore guard — each checked by
  mutation: dropping the code fails exactly the test named for it. `web/` has a broader browser suite,
  so the reader and the poller are still largely proven by hand. Closing that
  gap is the largest remaining test debt now that this is the product. One
  seam was moved to make the SSH and push tests possible: `push.ts` loads
  `expo-notifications` with an inline `require` rather than `import()`, which
  Metro defers identically and Jest can actually execute.
- **The refresh problem is not root-caused.** The owner reports needing to
  refresh the page; four plausible causes were fixed (a render crash with no
  boundary, a WebKit-only crash on `Notification`, a Screen tab left blank when
  a pane's real size arrived after its first frame — the terminal is now
  resized in place and repainted — and a locally served app that drew nothing
  for up to 15s while its first auth check was pending, which now says
  "Opening Shahi…") and none is confirmed to be *the* one. If it recurs, what
  matters is which of three shapes it takes — blank, frozen-with-stale-data, or
  claiming LIVE while not updating.
- **The plugin has been installed on five Linux distributions, by hand, once.**
  OrbStack VMs, 2026-09-04. Ubuntu 26.04 by `herdr plugin link`; Debian 12,
  Fedora 44 and Arch by the documented `herdr plugin install iYassr/shahi`.
  All four reached the same end state: startup hook, systemd **user** service,
  `/api/meta` answering, `relay.connected: true`. Debian and Fedora needed no
  workaround at all. Arch needed several — every one of them the distro's, not
  ours (`pacman -Sy` is a partial upgrade; it broke curl, which broke pacman).
  Two bugs came out of it that nothing else could find: `bunPath` writing
  bun's temporary node shim into `ExecStart=`, and `serviceFor` assuming Linux
  means systemd. Both fixed, both with tests named after the symptom.

  **Alpine is the honest exception.** busybox init, OpenRC, and no systemd in
  the repositories at all — `apk search -x systemd` returns nothing, so this is
  not a missing dependency but a different world. Everything else works there:
  the sidecar runs on musl, attaches to herdr, serves `/api/meta` and reaches
  the relay, all verified by running the unit's own ExecStart by hand. Only
  supervision is missing. `serviceFor` returns an unsupervised service
  instead of failing with `Executable not found in $PATH: "systemctl"`, and
  setup still writes the secrets and stages the approved release, then hands
  over the exact command a unit would have run, for the box's own init to keep
  running; `status` and `pair` work. It used to refuse before any of that,
  which left every verb, `status` included, failing before a secret existed.
  An OpenRC branch would not be a port of the user unit — OpenRC has no
  per-user services — so it is deliberately not written.

  None of this is automated, which is the argument for a CI job: both bugs were
  a first install away, and nobody will remember to do it by hand twice.
- **Codex output is now read in full, against a captured corpus — but only
  what that corpus held.** Every record, block and event type across the
  owner's real transcripts (79 Claude sessions, 23 codex rollouts) was
  enumerated and classified rendered-or-dropped; the dropped-but-real buckets
  were closed (codex reasoning, MCP, web search, native `apply_patch`; Claude
  model switches and `away_summary`/`model_refusal_fallback` notes). Codex
  0.151 then moved all four of those codex shapes into `item_completed` items,
  and the reader dropped them silently until a second census in September
  2026: 65 rollouts, codex 0.151 to 0.155, with 7,397 `Reasoning`, 1,258
  `McpToolCall`, 558 `FileChange` and 8 `WebSearch` items and not one legacy
  event. Both forms are read now. What remains unproven is a codex tool shape
  that never appeared in those rollouts — it degrades to dropped, never
  guessed, so the failure is silence, not invention. Re-run the census
  (`server/lib/*-log.test.ts` document each shape) when a new agent version or
  a new tool lands; the 0.151 change is what skipping it costs.
- **Codex transcript reads are now indexed.** Byte ranges and matching tool
  output ranges are indexed incrementally; unchanged tail requests parse only
  their window. `codex-index.test.ts` covers append/truncate/replacement,
  partial UTF-8 records, pagination and bounded LRU retention. The dashboard's
  per-pane summaries (preview and `lastMessageAt`) are cached by transcript
  path, inode, size and mtime, and pruned each round to the panes that exist,
  so an unchanged transcript costs one `stat` per round and never touches the
  readers' 64-entry index LRUs; a session with more than 64 agent panes used to
  re-parse transcripts every 3s. The LRUs still bound the readers' own
  indexes.
- **The relay has no CI of its own beyond `bun test relay` under
  `wrangler dev`.** The box↔relay↔phone loop was proven by hand against the
  deployed Worker (a fake phone in `bun`, then the app on a simulator paired
  by a `shahi://pair` link and running a shell command). A live job that
  deploys to a preview Worker and runs the fake phone is the obvious next
  step; it needs a Cloudflare token in CI.
- **`agent.prompt` is not exercised against a real agent in CI.** The live
  suite proves it refuses a non-agent pane with a code; the runners have no
  claude or codex to prompt. On a machine that has one,
  `SHAHI_HERDR_LIVE_AGENT=1` adds a test that starts a claude in the scratch
  workspace and proves the agent path end to end. The terminal path is proven
  everywhere.
- **Request timing instrumentation is operational, not tap-to-render.** The sidecar records bounded route-template counts and latency histograms in `/api/diagnostics`; private JSON logs and local alert transitions rotate beside its database. Relay metadata and service incident alerts are documented in `docs/operations.md`. Never add terminal contents, raw paths, credentials or raw error messages to these records.
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
includes the Expo app, the only automatic check that the two clients have not
drifted apart — then the unit tests, the relay suite (`test:relay`) and the
app's own (`test:mobile`), then a web build and both Playwright engines.
Traces from a failing run are uploaded as an artifact.

**And a real herdr.** `server/lib/herdr-live.test.ts` runs the adapter and the
sidecar against a headless herdr: the protocol pin, snapshot shapes, the
mirror and dashboard projection, `pane.read` in every form the app uses, a
prompt typed into a scratch shell and read back, every key-bar name, the event
stream, and the HTTP routes including the 426 gate. CI runs it three times per
push — against `v0.9.0`, the minimum supported release, and `v0.9.1`, both
pinned by tag and by the SHA-256 of their `herdr-linux-x86_64` asset, and
against whatever herdr's own installer hands out today, read from
`herdr.dev/latest.json` (version and checksum) and cross-checked against
GitHub — and nightly against the newest prerelease (`herdr-preview.yml`),
checked only against its own release's digest. Every herdr in CI is installed
by `.github/scripts/install-herdr.sh`, which refuses a binary whose bytes do not
match GitHub's digest for the asset (and the pinned one, when given), and never
runs it; `install.sh` is no longer piped into `sh`. A failed nightly files an
issue rather than failing a push, and that issue is filed by a separate
`report` job that has only `issues: write`, no checkout, and runs nothing but
`gh`; the job that runs the preview is `contents: read`. Every checkout in every
workflow sets `persist-credentials: false`, which `.github/workflows.test.ts`
enforces. The live suite writes only into a workspace it creates and closes, on
a herdr you point it at explicitly — and that herdr must be a **named session**:

A named session isolates panes, **not installed startup hooks**. Always use a
fresh `XDG_CONFIG_HOME` as well, so no plugins are installed in the test
configuration. On 2026-09-18, starting a named session under the normal config
ran Shahi’s startup hook and repointed the production service at the test
socket. Keep the normal `HOME` so installed agents remain available; do not
copy plugins into the test configuration. Use the same configuration root when
stopping the named session.

```sh
test_config_root=$(mktemp -d /tmp/shahi-live.XXXXXX)
XDG_CONFIG_HOME="$test_config_root" herdr --session shahi-ci server &
export HERDR_SOCKET_PATH="$test_config_root/herdr/sessions/shahi-ci/herdr.sock"
SHAHI_HERDR_LIVE=1 bun test server/lib/herdr-live.test.ts
XDG_CONFIG_HOME="$test_config_root" herdr session stop shahi-ci
unset HERDR_SOCKET_PATH
```

The root is short on purpose. A plain `mktemp -d` on macOS lands under
`$TMPDIR` (`/var/folders/…/T/`), which makes the session's
`herdr-client.sock` path 105 bytes, over the 104 a macOS socket address holds,
and herdr refuses to start.

`HERDR_SOCKET_PATH=/tmp/x.sock herdr server` is not isolation, and this was
learned the expensive way: a second server on a new socket restores the
*default* session's persisted state, and with `resume_agents_on_restore` (the
default) it re-launches every agent in it — measured here as four duplicate
`claude --resume` processes of the owner's live sessions, sitting in PTYs
under the scratch server until it was stopped. A named session has its own
directory under `~/.config/herdr/sessions/` and starts with nothing in it.

A newer stable protocol fails the pinned job on purpose: regenerate
(`bun run gen:types`), read the diff, and bump the pin here and in `ci.yml`.
A pinned tag needs its digest beside it in the herdr matrix's `include`:
`gh api repos/herdrdev/herdr/releases/tags/vX.Y.Z --jq '.assets[] | select(.name=="herdr-linux-x86_64") | .digest'`.

The hosted and PWA Playwright configs hard-code ports 7472, 7572 and 7672;
something else listening there fails those suites.

## The two clients

**`mobile/` is the product.** August 2026: a paid Apple account made a real
build possible, and the decision followed that native is where this goes —
voice dictation and anything else that needs the device properly are not things
a web page does well.

**`web/` is actively maintained alongside mobile.** The owner restored web
feature development on 2026-09-05. Mobile is the behavior reference; browser
implementations use the same semantic Shahi routes and adapt navigation and
layout to phone and laptop screens. Settings, device management, reader history,
and startup/retry behavior should stay aligned. Native-only capabilities such
as an in-app SSH tunnel remain native. The hosted client at getshahi.dev/pwa
pairs through the shared encrypted relay protocol; the locally served web build
uses its existing origin or an external tunnel. See docs/browser-hosting.md.

That split has a cost that was already paid once. Every change between January
and August landed only in the PWA, so the native app arrived on the phone
missing agent permission modes, the file viewer, `AskUserQuestion` cards and
the context above a prompt — the last two meaning a codex approval showed as a
bare question with nothing to judge it by. All four are ported. The lesson is
cheap to state and was expensive to find: **a feature that only exists in
`web/` does not exist.**

Still only in the PWA: the recorded-terminal history view — `api.transcript`
and the `GAP_MARKER` that explains a break in it. The native app's unused
client method for it has been deleted — an API method with no caller reads as
coverage that is not there — so porting the view means adding it back. The terminal
itself is a separate matter: xterm.js has no React Native port, so the Screen
tab would have to run in a WebView.

The spaces view and the reader's jump-to-latest pill are both ported; this
paragraph claimed otherwise for months.

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

## Customer-flow invariants

**Large text must keep the conversation identifiable.** Native agent titles
get a separate line at accessibility font sizes; metadata must not consume
their entire width. Test both a cold launch at the selected size and changing
size while running. Web sheets need a visible, labeled close control inside
the focus boundary; symbolic terminal keys need spoken names. See the dated
`docs/ui-ux-audit-2026-09-18.md` for fixes and verification limits. Native
UI text uses `@/components/text` beneath `TypographyProvider`: font-scale
changes replace only text hosts to invalidate stale iOS measurements. Never
key the navigator or screen by font scale; doing so loses drafts and position.

**Finding and opening work should agree across clients.** Agent search matches
conversation, space, folder and provider while preserving the selected filter.
Native local Markdown links use the authenticated file viewer for absolute or
home-relative computer paths, never phone `file://` URLs. Text and image previews
are supported; unsupported formats and unavailable files need readable feedback.
Keep advanced connection details collapsed and highest-permission cautions
visible even before selection.

**Creating must also make the result readable.** Workspace, tab and agent
creation await `SessionStore.resyncAfterMutation()` before returning success.
A snapshot already in flight can predate the write, so wait for it and then
request a fresh one. Otherwise the client opens a real new pane and receives
a false 404. Web retries when a later authoritative session first reports that
pane; do not turn genuine missing panes into an endless polling loop. Keep
readable agent labels separate from herdr’s restricted internal names.

**Drafts are private, bounded, and memory-only.** Web scopes drafts by server
and device grant; native scopes them by the stable computer API object. Pane
IDs alone are not unique across computers. Each scope retains at most 20 panes;
web retains at most eight scopes. Navigation and background/resume can preserve
a draft, but reload/process termination cannot. Clear the scope on logout or
revocation. A pending send retains its operation ID, and a late receipt must
not clear a newer draft or change a dismissed screen. Native disables editing
during the pending send; web preserves subsequent edits.

**Uploads negotiate bounded, resumable transfer.** Updated relay clients ask
`/api/uploads/limits` and send up to 32 MiB as sequential 64 KiB requests. Keep
1 MiB encrypted frames, bounded queues and the 64 KiB/s byte rate. Chunk routes
share the HTTP file-work admission limit and bulk-pacing rules. Transfers are
owned by a device/session, journal offsets before acknowledgment, reject
conflicting retries and finalize once after SHA-256 verification. Never replay
uncertain chat writes. One active transfer per device/two per computer bounds
storage. Clients mint a fresh id for every upload and run one at a time, so
beginning a transfer discards the same device's or session's unfinished,
non-finalizing one — an app kill or a lost cancel used to block that phone for
the rest of the hour — and the periodic sweep discards any unfinished transfer
idle for 10 minutes; one hour remains the hard cap. Completed receipts also
have a count cap. Keep partials outside projects. Multipart uploads are
written 0600 in a 0700 directory (chmodded if older), and the multipart route
checks authorization again after the body arrives, since revocation can land
while a slow body is still coming. The shared helper reads bounded
ranges on both clients and supports progress/cancellation. Process termination
requires file reselection. Old computers retain 761 KiB relay uploads; SSH
remains 32 MiB. Do not raise rates based on a small-message load test.

**Reader state belongs to its connection.** Late history responses from a
previous computer must not repopulate cleared caches. Preserve the anchor,
offset and loaded history window on return; Latest must reach the actual end.
Restoration must yield to deliberate keyboard/focus scrolling as well as touch.
Native Read/Screen controls stay in the content layout so long navigation titles
cannot cover their touch targets. Apply terminal and transcript responses
independently, and never gate Screen rendering on transcript loading.
A failed refresh must keep cached conversation messages visible. Connectivity
changes preserve the computer API identity and its drafts; recovery never sends
a draft automatically. See `docs/mobile-recovery-2026-09-22.md`.

Reader state also belongs to its transcript. A herdr pane outlives the
conversation in it, and Codex and Cursor number messages by position, so every
transcript has a message 0 and a merge by id showed two sessions as one
thread. Their message ids are now `<sessionId>:codex-<row>` and
`<sessionId>:cursor-<n>`, so ids never match across transcripts, and
`/session`'s `sessionId` changes whenever the pane's transcript does; clients
may compare it. Every open Codex or Cursor pane resets its cached page once
when an updated sidecar first answers. The web reader replaces the view — not
merges it — when a page's `sessionId` or path differs from the one on screen,
resetting the history offset, the unseen count and the scroll place, and
discards a late "Load earlier" page from the previous transcript.

For dated evidence and remaining physical-device gaps, see
`docs/customer-journeys-2026-09-18.md` and the reports linked there. Keep test
counts in dated reports, not permanent development instructions.

## Review fixes, September 2026

Prompts and agent starts carry client-generated operation IDs. The sidecar
retains the in-flight promise and its outcome for ten minutes: successes, and
failures whose write may already have reached herdr. A failure that provably
reached nothing is not kept, so a retry under the same ID runs again
(`server/lib/herdr-delivery.ts`): a socket that would not open (`ENOENT`,
`ECONNREFUSED`, `EACCES`, `ENOTSOCK`), or a herdr refusal made before it acts
(`agent_blocked`, `agent_not_ready`, `agent_not_found`, `pane_not_found`,
`invalid_*`). Read-only herdr calls never count as delivery, so a prompt
refused with `prompt_open` after only reading the screen can be retried once
the menu is gone. Anything else counts as delivered: a replayed error is the
safe mistake, a repeated write is not. Retrying an uncertain operation must
reuse its ID; a new ID means a new action. This is process-local
retry protection, not a claim of exactly-once execution across a server crash.
Agent startup uses the shared 325-second client deadline and disables Bun's
per-request idle timeout only after authentication and validation.

Push registrations now belong to their device or passcode session. Old unowned
registrations are discarded on upgrade; enable notifications again. Revocation
and server-side logout remove the owner's registrations on both push channels.

The relay records operational metadata in Analytics Engine. Keep privacy copy
in docs/privacy-policy.md and site/public/privacy.html aligned with the fields
in relay/src/telemetry.ts and the configured retention; do not claim that the
relay stores nothing.

Hosted browser releases use `bun run build:site` and the existing Cloudflare
site configuration. Keep /pwa routing and service-worker scope isolated from
marketing assets; every same-origin page remains in the browser trust boundary.
Never add third-party scripts or cache decrypted session data. Browser pairing
is session-only unless remembering is explicitly selected.

**Relay recovery must survive suspended timers.** The computer's relay watchdog
runs through connected, handshaking and retry states. A delayed tick after sleep
replaces the socket even if a buffered pong arrived first. Keep retries bounded
in rate but unlimited in count, preserve pairing identity, and never replay
uncertain writes. `relay-recovery.test.ts` covers stuck sockets and lifecycle
races; `relay-resume.test.ts` suspends only a disposable child process, never the
user's computer or live service.

For the five-VM regression results and deployed-relay fault checks, see
`docs/relay-recovery-vms-2026-09-18.md`. Live probes require explicit opt-in and
must use disposable identities and uniquely named test services.

## Private documents and credentials

Keep signed forms, France/ANSSI declarations, signatures, email exports, personal
contact/address details, reviewer passwords, pairing identities and signing keys
outside the repository, including ignored project folders. Use a private folder
elsewhere on the owner's computer. Never copy these into documentation, fixtures,
screenshots, build contexts, commits or public artifacts. Public documentation
may describe procedures and current release limitations, but not private
correspondence or completed forms. Check staged paths and content before pushing;
ignore rules do not protect files already tracked by Git. The public Expo update
verification certificate is not a private signing key and may remain tracked.

## TestFlight feedback fixes, September 2026

New-agent clients derive an internal control name from the retained operation ID,
so old servers also avoid globally colliding default names. Keep the operation
ID and internal name stable on uncertain retries; display labels remain separate.
Cursor CLI Read mode uses its exact reported session or the pane process's open
`store.db` to find JSONL under `.cursor/projects/*/agent-transcripts/`. Never
select a transcript by folder recency. Missing recorded tool outputs are explicit.
Cursor user turns show only their `<user_query>` text; `<timestamp>`,
`<dynamic_tools>` and other wrapped context are dropped, because every user
bubble had shown them as something the person typed.

PDFs use local PDFKit on iOS and a lazily loaded PDF.js canvas renderer on the
web. Never upload documents to a third-party viewer. iOS shares a protected
temporary local copy and deletes it when the share sheet finishes. This native
module requires a new binary, not only an over-the-air JavaScript update. File
downloads use authenticated sequential ranges of 512 KiB, retain the 25 MiB
ceiling and reject changed file versions. Older small-file responses still work.

**Conversation order follows messages.** Both clients default to newest message
first, with explicitly pinned conversations above the regular list. Waiting
cards stay in chronological position outside Inbox. The server supplies optional
`lastMessageAt` from each pane's exact transcript; Cursor lacks message timestamps
and uses that transcript's modification time. Missing dates sort last, stably.
Never use terminal repaint, focus or status-change times as chat activity.
Connected clients receive changed transcript summaries even when herdr metadata
is unchanged. This additive field requires an updated sidecar for dated ordering;
older servers remain readable without invented timestamps.

**Launch acceptance is not composer readiness.** Live herdr 0.9.1 can return
`agent_started` with `launch_pending` before accepting input. The start adapter
waits on `agent.get` for that same pane, within the existing startup deadline;
never launch again to wait for readiness. The web Read tab remains available
when a fresh conversation has no transcript yet, so later output can be opened.
