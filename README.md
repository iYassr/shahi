# Shahi

**See and answer your terminal agents from your phone.**

Shahi shows the AI agents running on a server you control — Claude Code, codex,
plain shells — and lets you reply from anywhere. When an agent stops to ask a
question, your phone shows the real question with its real options as native
buttons; tap one and the answer goes back to the terminal. Everything else
collapses to a single line, so a screen full of panes reads at a glance.

<p align="center">
  <img src="docs/screenshots/02-agents.png" width="23%" alt="Agents — what needs you right now, with a blocked agent's question rebuilt as native buttons" />
  <img src="docs/screenshots/04-reader.png" width="23%" alt="Reader — an agent's conversation, reflowed to fit the phone, with a reply box" />
  <img src="docs/screenshots/03-spaces.png" width="23%" alt="Spaces — where things live: spaces, their tabs, and their panes" />
  <img src="docs/screenshots/01-onboarding.png" width="23%" alt="Onboarding — one command on your server, then connect" />
</p>

It talks to a small helper you install once on the machine your agents run on.
Nothing is proxied through a server of ours — there is no "us" in the path.

## What it is, and what it talks to

Shahi is a native iOS app plus a sidecar you run next to your agents. Today the
sidecar speaks to [**herdr**](https://herdr.dev), a terminal multiplexer.
**tmux is the planned second backend** — the adapter is deliberately isolated
(`server/lib/herdr-*.ts`) so a sibling can slot in beside it, and the app was
named for the phone-shaped window rather than for one multiplexer. For now,
**herdr is the only supported backend.**

herdr's TUI is excellent on a desktop and painful on a phone — 146-column output
on a four-inch screen, chord keybindings an iOS keyboard cannot produce, and
dozens of panes to navigate blind. herdr lists "no web view" as an explicit
non-goal, so Shahi is a sidecar rather than a fork: it owns herdr's unix socket
and adds the three things herdr deliberately omits — HTTP, WebSocket, and
authentication.

The app has two views, matching how herdr splits its own sidebar. **Agents** is
triage — what needs you right now. **Spaces** is structure — where things live,
which tabs are in them, and where new work goes. Plain shells are reachable from
Spaces; on a phone that is the only way to get at roughly half the panes in a
real session.

## Setup

Two parts: install the sidecar on your server, then connect the app.

### 1. The server

One command, on the machine herdr runs on:

```sh
curl -fsSL https://raw.githubusercontent.com/iYassr/shahi/master/install.sh | bash
```

It checks that herdr is there, fetches and builds, generates a passcode, installs
a systemd user service, enables lingering so it survives logout, and prints the
address. Running it again upgrades in place and leaves your passcode alone.

<details>
<summary>By hand instead</summary>

```sh
bun install
bun run gen:types                                           # from herdr's own schema
bun run server/scripts/init-secrets.ts --passcode <digits>  # writes .env, mode 0600
bun run build:web
bun run server/index.ts
```

Then, to keep it running:

```sh
cp deploy/shahi.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now shahi
sudo loginctl enable-linger "$USER"     # survive logout
```
</details>

### 2. The app

Enter the address and passcode the installer printed. Two ways to reach the
server, and the choice is really about how you already log in.

- **Over Tailscale** — bind the sidecar to your tailnet address and the app
  connects to `https://<host>.<tailnet>.ts.net` directly. Put TLS in front with
  `tailscale serve --bg --https=443 http://127.0.0.1:7171` so the connection is
  a [secure context](https://developer.mozilla.org/docs/Web/Security/Secure_Contexts)
  — that is what lets notifications through.
- **Over SSH** — the app opens its own SSH tunnel to the box (the same
  credentials you already use) and forwards to the sidecar on loopback. Nothing
  needs to be exposed on the tailnet at all. The server's host key is pinned on
  first connect, so a changed key is refused before any credential is sent.

**Never `tailscale funnel`** — that would put an unauthenticated-by-default herdr
proxy on the public internet.

## Security

The API proxies every herdr method, and `pane.send_text` alone is arbitrary
shell execution as you. Three layers, in order of importance:

1. **Bind address.** Defaults to loopback. Widen it to a Tailscale address
   deliberately, never to `0.0.0.0`, which also publishes on your LAN.
2. **Tailnet or SSH only.** The port is never on the public internet; reach it
   across your own tailnet, or tunnel to it over SSH.
3. **App passcode.** Tailscale (or SSH) authenticates the *device*; the passcode
   authenticates the *person* holding it. When the sidecar is bound off loopback
   it is the only layer between the port and full control of every agent on the
   machine.

Terminal output is never logged — those screens carry whatever is in your
terminals. Credentials (passcode, SSH key, host fingerprints) live only in the
iOS Keychain and are never sent to anyone but your own server.

## Under the hood

The parts that were surprising enough to be worth writing down. The full account
for anyone changing the code is in [`CLAUDE.md`](CLAUDE.md).

### The reader reads the agent's own transcript, not the terminal

The pane screen herdr exposes is pre-wrapped at the server's width, ~42 rows
deep, with no scrollback — anything built on it is scraping a redrawing TUI. But
Claude Code writes its own structured JSONL transcript per session under
`~/.claude/projects/`, and herdr's session id **is that file's name**. So the
reader is a file read plus a renderer, with no terminal parsing at all, and it
can reflow text because the text was never wrapped to begin with.

Measured across 48 transcripts and 8,298 records, the format has one trap that
dominates: **87% of `user` records are not from the user** — they carry
`tool_result` blocks, because that is how tool output returns through the API.
Rendering `type: "user"` as "you said" misattributes almost all tool output to
the human, so tool calls are paired with their results and shown as one
collapsible row. Only Claude Code writes this format; codex keeps its own store,
and shells have no transcript, so the terminal view stays the universal fallback.

### What herdr's API does and does not give you

Measured against herdr 0.7.5 (protocol 17); several points contradict the
official docs, and they shape the whole design.

| | |
|---|---|
| **Transport** | Unix socket, newline-delimited JSON. No network surface at all — hence a sidecar. |
| **Connections** | The server closes after **one** response, despite the docs saying connections are persistent. `events.subscribe` is the sole exception. |
| **Live output** | There is none. Change events carry `{pane_id, revision}` and no content; output arrives only by calling `pane.read`. |
| **`revision`** | Does not track output — it stayed at `0` across four reads of a pane whose text was visibly changing. Change detection is a content hash. |
| **Scrollback** | None from the API. Shahi records its own, diffing successive screens so the phone can read further back than the TUI can. |
| **Client size** | Cannot be declared. Output is pre-wrapped at the server's width, so the app renders faithfully and lets you scale rather than re-wrapping. |
| **Status events** | `pane.updated` does **not** report agent-status transitions. Relying on events alone drifted on 18 of 18 checks, so the mirror is re-snapshotted every few seconds. |

### Attachments

Both a phone photo/file and a file browsed on the server end as an absolute path
in the message, because that is what an agent can act on. Uploads never land in
the agent's working directory, names are reduced to a safe basename
(`../../../etc/passwd` becomes `passwd`), files are timestamped so two `IMG_0001.jpg`
cannot collide, anything over 32MB is refused, and uploads older than two weeks
are swept.

## Development

```
shared/    the wire contract, types only — both clients import it
server/    Bun sidecar: owns herdr's unix socket, speaks HTTP + WebSocket
mobile/    the Expo (React Native) app — the product, where new work goes
web/       the React PWA, archived: still builds and passes, no longer developed
e2e/       Playwright + Maestro, against a stub of the server
```

```sh
bun test shared/src server web/src        # unit
cd mobile && bun run test                 # native unit tests (jest)
bun run test:e2e                           # web engines, against the stub
maestro test .maestro/                     # native flows, against the stub
bun run typecheck                          # both clients share shared/, so this catches drift
```

The suite runs against `e2e/stub/server.ts`, which speaks the same contract with
no herdr behind it and records writes instead of performing them — so tests never
touch a live session. See [`CLAUDE.md`](CLAUDE.md) for how the pieces fit and the
decisions worth not relitigating.

Contributions welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## More

- [`docs/operations.md`](docs/operations.md) — running it: TLS, health, where state lives
- [`docs/notifications.md`](docs/notifications.md) — which setups can actually deliver a notification
- [`docs/app-store.md`](docs/app-store.md) — what the iOS build needs before submission
- [`docs/privacy-policy.md`](docs/privacy-policy.md) — draft privacy policy
- [`CLAUDE.md`](CLAUDE.md) — the measured truth about herdr, and the architecture

## License

[MIT](LICENSE).
