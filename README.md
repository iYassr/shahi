# HerdrUI

A phone-shaped view of a running [herdr](https://herdr.dev) session: which agent
needs you, what it is asking, and a way to answer it.

herdr's TUI is excellent on a desktop and painful on a phone — 146-column output
on a four-inch screen, chord keybindings an iOS keyboard cannot produce, and
dozens of panes to navigate blind. The project lists "no web view" as an explicit
non-goal, so this is a sidecar rather than a fork: it owns herdr's unix socket
and adds the three things herdr deliberately omits — HTTP, WebSocket, and
authentication.

Two views, matching how herdr splits its own sidebar. **Agents** is triage —
what needs you right now. **Spaces** is structure — where things live, which
tabs are in them, and where new work goes. Plain shells are reachable from
Spaces; on a phone that is the only way to get at roughly half the panes in a
real session.

The home screen is not a terminal. A blocked agent gets a card carrying its real
question and its real options, rebuilt as native buttons; everything else
collapses to one line.

```
┌─────────────────────────────────────┐
│ herdr                2 WAITING LIVE │
├─────────────────────────────────────┤
│ ● WAITING ON YOU                    │
│ security program                    │
│ claude · w4:p2 · enrich-reg-map-001 │
│                                     │
│ Claude has written up a plan and is │
│ ready to execute. Would you like to │
│ proceed?                            │
│                                     │
│ ❯ 1. Yes, and bypass permissions    │
│   2. Yes, manually approve edits    │
│   3. No, refine with Ultraplan      │
│   4. Tell Claude what to change     │
├─────────────────────────────────────┤
│ EVERYTHING ELSE                     │
│ ◐ herdr-mobile-dashboard       test │
│ ○ ringtone-bird-prank          Naif │
└─────────────────────────────────────┘
```

## Setup

Requires Bun and a herdr server already running on the same machine.

```sh
bun install
bun run gen:types                                          # from herdr's own schema
bun run server/scripts/init-secrets.ts --passcode <digits>  # writes .env, mode 0600
bun run --cwd web build
WEB_ROOT=$PWD/web/dist bun run server/index.ts
```

Then, to keep it running:

```sh
cp deploy/herdrui.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now herdrui
sudo loginctl enable-linger "$USER"     # survive logout
```

### Reaching it from a phone

Two options, and the choice is really about notifications.

**Bind the tailnet directly** — what the shipped unit does. Set
`HOST=<your 100.x.y.z>` and the app answers on
`http://<node>.<tailnet>.ts.net:7171` with no extra moving parts and no root.

Bind the Tailscale address specifically, not `0.0.0.0`: the latter also
publishes on your LAN, which is a far larger audience than your tailnet.

The cost is real, though. Plain HTTP is not a
[secure context](https://developer.mozilla.org/docs/Web/Security/Secure_Contexts),
so the browser refuses to register a service worker — and a service worker is
the only delivery path for Web Push. **Notifications will not arrive.** The
dashboard, prompt answering and terminal all work normally. The server says so
at startup rather than letting you discover it later.

**Put TLS in front** — keeps `HOST` at loopback:

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:7171
```

Tailscale supplies a real certificate for your node's name, so the page is a
secure context: the PWA installs to the home screen and Web Push works. This is
the option to choose if you want your phone to buzz when an agent blocks.

**Never `tailscale funnel`** — that would put an unauthenticated-by-default
herdr proxy on the public internet.

## Security

The API proxies every herdr method, and `pane.send_text` alone is arbitrary
shell execution as you. Three layers, in order of importance:

1. **Bind address.** Defaults to loopback. Widen it to a Tailscale address
   deliberately, never to `0.0.0.0`, which also publishes on your LAN.
2. **Tailnet only.** Optionally tighten further with a tailnet ACL restricting
   this node's port to your own devices.
3. **App passcode.** Tailscale authenticates the *device*; the passcode
   authenticates the person holding it. This is what protects you if a phone is
   unlocked by someone else — and when bound off loopback it is the only layer
   between the port and full control of every agent on the machine.

Terminal output is never logged — those screens carry whatever is in your
terminals.

## What herdr's API does and does not give you

Everything below was measured against herdr 0.7.5 (protocol 17), and several
points contradict the official docs. They shape the whole design.

| | |
|---|---|
| **Transport** | Unix socket, newline-delimited JSON. No network surface at all — hence a sidecar. |
| **Connections** | The server closes after **one** response, despite the docs saying connections are persistent. `events.subscribe` is the sole exception. |
| **Live output** | There is none. `pane_output_changed` carries `{pane_id, revision}` and no content. Output only arrives by calling `pane.read`. |
| **`revision`** | Does not track output. It stayed at `0` across four reads of a pane whose text was visibly changing. Change detection is a content hash. |
| **Scrollback** | None. `lines=50`, `200` and `2000` all return the same 42 rows, and there is no scroll method. |
| **Client size** | Cannot be declared. Output is pre-wrapped at the server's width, and `recent_unwrapped` returns the same text because Claude Code wraps its own output. |
| **Status events** | `pane.updated` does **not** report `agent_status` transitions. Only `pane.agent_status_changed` does, and it needs a `pane_id` per subscription. |
| **`cwd` on create** | Not tilde-expanded, and not rejected either — `~/foo` silently becomes `$HOME`. Always pass absolute paths. |

Two of those turned into features rather than limitations:

- **The scrollback recorder** (`server/lib/transcript.ts`) diffs successive
  screens and archives what scrolls off the top, so the phone can read further
  back than the TUI can. Where output outran the poll interval it records a gap
  marker rather than splicing unrelated output into something that reads as
  continuous.
- **Periodic re-snapshotting** (`server/lib/state.ts`) is what makes the
  dashboard trustworthy. Relying on events alone drifted on 18 of 18 checks,
  including `mirror=idle herdr=blocked` — the app silently missing the one agent
  it exists to surface.

## Reader view

The pane screen herdr exposes is pre-wrapped at the server's width, 42 rows
deep, with no scrollback — anything built on it is scraping a redrawing TUI. But
Claude Code writes its own structured JSONL transcript per session under
`~/.claude/projects/`, and herdr's `agent_session.value` **is that file's name**.
So the reader view is a file read plus a renderer, with no terminal parsing at
all, and it can reflow text because the text was never wrapped to begin with.

Measured across 48 transcripts and 8,298 records, the format has one trap that
dominates everything else: **87% of `user` records are not from the user.** 1,509
of 1,736 carry nothing but `tool_result` blocks, because that is how tool output
returns through the API. Rendering `type: "user"` as "you said" misattributes
almost all tool output to the human. `<task-notification>` blocks are the same
trap in miniature. Tool calls are therefore paired with their results and shown
as one collapsible row.

Existing viewers for this format are worth knowing about —
[claude-code-trace](https://github.com/delexw/claude-code-trace),
[claude-code-log](https://github.com/daaain/claude-code-log),
[claude-code-transcripts](https://github.com/simonw/claude-code-transcripts) —
but all are standalone apps with their own servers and UI, so none could sit
above the answer buttons for a blocked agent. `claude-code-log`'s renderer was
read as a reference for edge cases.

Only Claude Code writes this format. `codex`, `pi` and `opencode` keep their own
stores, and shells have no transcript at all, so the terminal view stays the
universal fallback rather than a legacy one.

## Grouping the agent list

Three modes, using herdr's own vocabulary: **Priority** (its attention queue),
**Space**, and **Agent**. The default is read from your `ui.agent_panel_sort` in
`~/.config/herdr/config.toml`, so the phone opens the way your TUI already does;
an explicit choice is remembered per device. herdr's socket API can reload
config but cannot report it, so the file is read directly, and any failure just
means "no preference stated".

Blocked agents are deliberately **not** grouped. They stay pinned above the
grouping control, because burying the one agent waiting on you inside the fifth
space would defeat the screen.

## Attachments

Both sources end as an absolute path in the message, because that is what an
agent can act on — it cannot receive a file over a terminal, but it can read one
off disk, images included.

- **From the phone** — photo library, Files, or straight to the camera. The file
  uploads to `~/.local/share/herdrui/uploads/` and is referenced by path.
- **On the server** — browse from the pane's own directory and tap a file.

Uploads never land in the agent's working directory: a file arriving from a
phone should not be able to overwrite a source file the agent is mid-edit on.
Names are reduced to a safe basename before use, so `../../../etc/passwd`
becomes `passwd` inside the upload directory, and files are timestamped so two
photos both called `IMG_0001.jpg` cannot overwrite each other. Anything over
32MB is refused. Uploads older than two weeks are swept on the next write.

## Checking it still works

Unit tests cover the parser, the transcript recorder, auth, config, and the
state mirror. The scripts talk to the live server; all are read-only except the
last, which creates and closes its own scratch workspace.

```sh
bun test server web/src

bun run server/scripts/smoke.ts               # socket client end-to-end
bun run server/scripts/check-parser-live.ts   # prompt parser across every pane
bun run server/scripts/check-mirror-drift.ts  # mirror vs live snapshots
bun run server/scripts/check-transcript-live.ts
bun run server/scripts/check-http-live.ts     # auth boundary, WS, frame scoping
bun run server/scripts/measure-poll-cost.ts   # polling load on the herdr server

bun run server/scripts/verify-key-delivery.ts # what send_keys actually delivers
```

`check-parser-live` is the one worth re-running after a Claude Code upgrade: it
sweeps every pane and fails on a false positive, which is the costly direction —
offering answer buttons for a question nobody asked.

## Answering strategy

Key delivery is verified: `keys: ["2"]` puts a literal `2` on the process's
stdin, and `["Down","Down","Enter"]` arrives in order as `\x1b[B \x1b[B \r`.

Digits are the default because they do not depend on knowing where the cursor
sits. If a tap ever fails to move a real prompt, flip `ANSWER_STRATEGY` in
`web/src/api.ts` to `"arrows"`, which walks the cursor from the option the parser
saw selected to the one you tapped.

## Layout

```
server/
  index.ts               entry point
  lib/herdr-client.ts    the socket: one connection per RPC, one held for events
  lib/state.ts           session mirror — events plus periodic re-snapshot
  lib/poller.ts          adaptive pane.read polling, hash-based change detection
  lib/transcript.ts      scrollback herdr does not keep
  lib/prompt-parser.ts   blocked screen -> question + options
  lib/http.ts            REST, WebSocket, static assets
  lib/auth.ts            passcode gate
  lib/push.ts            Web Push on transition into blocked
  fixtures/              real captured screens — see fixtures/README.md
web/
  src/components/Prompt.tsx  the answer list, rebuilt from the terminal's own
```
