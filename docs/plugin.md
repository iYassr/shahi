# Shahi as a herdr plugin

The way to install the sidecar if you already run herdr — which you do, or
there is nothing for Shahi to show.

```sh
herdr plugin install iYassr/shahi
herdr plugin action invoke shahi.restart     # or restart herdr
```

Then **Pair a phone** from herdr's command palette and scan the QR with the
app. That is the whole setup: the phone reaches the box through Shahi's relay
from anywhere, so nothing has to be exposed, tunnelled or typed.

`herdr plugin install` clones the repository, shows you the manifest and the
commands it will run, runs the build steps (`bun install --frozen-lockfile`,
`bun run build:web`) and registers the plugin. The `restart` action — or the
next herdr start, which runs the plugin's startup hook — does the rest:
generates a passcode and the keys that go with it, points the box at the
relay, installs a user service that supervises the sidecar, starts it, and
tells you it is running in herdr's notification tray. The hook runs on every
herdr start and is idempotent: the second run keeps your passcode and simply
restarts the service on whatever code is checked out.

It needs **herdr 0.8.2 or newer** on **macOS or Linux**. It also needs
[bun](https://bun.sh), and installs it if there is none: every command in the
manifest goes through `plugin/bun.sh`, which finds bun in the places herdr's
PATH may not include and otherwise — during `herdr plugin install` only,
never from a hook or an action — runs bun's own installer into `~/.bun`.
That installer also adds `~/.bun/bin` to your shell's rc file, as it always
does, and needs `curl`, `unzip` and `bash` on the box (`apt install unzip`
is the usual missing one on a fresh Debian or Ubuntu). On a headless Linux
box, see the lingering note under *What gets created*.

`install.sh` still exists and still works. Prefer the plugin: it is the path
the public release will be judged on, and the installer will go once the
plugin has been through a release cycle on a Linux box.

## What gets created, and where

herdr gives every plugin two directories and keeps them apart from the
checkout, which a reinstall replaces. Nothing that must survive an update is
in the checkout.

| | macOS | Linux |
|---|---|---|
| **secrets** — `.env`, mode 0600 | `~/.config/herdr/plugins/config/shahi/.env` | same |
| **data** — SQLite: transcripts, paired phones, push subscriptions, the server's identity | `~/.local/state/herdr/plugins/shahi/shahi.sqlite` | same |
| **log** — the sidecar's stdout and stderr | `~/.local/state/herdr/plugins/shahi/shahi.log` | same |
| **service** | `~/Library/LaunchAgents/app.shahi.sidecar.plist` | `~/.config/systemd/user/shahi.service` |
| **checkout** — the code, `web/dist` | `herdr plugin list --json` → `plugin_root` | same |

`herdr plugin config-dir shahi` prints the config directory, which is the
one you might edit. The paths above were measured on this Mac; on a machine
with `XDG_*` set they follow it.

The service is what keeps the sidecar alive across herdr restarts, crashes
and reboots — herdr's own startup hooks are one-shot by contract, "not
supervised daemons", so the hook installs the service rather than being it.
It is re-rendered and restarted on every herdr start, because after
`herdr plugin install` replaces the checkout a sidecar that kept running the
old code from memory would look updated and not be. **On Linux, a headless
box needs `loginctl enable-linger $USER`** once, or the user service stops
when your last SSH session ends — precisely when you would want to reach it
from a phone. `install.sh` did that for you; the plugin cannot, since it
needs sudo on some distributions, so it is said here instead.

The service follows the herdr that ran the hook last: its `HERDR_SOCKET_PATH`
is the one herdr injected, so a named session (`herdr --session work`)
takes the sidecar with it. There is one sidecar per user, not one per
session.

## The passcode

The first run prints a four-digit passcode, once. Startup hook output lands
in herdr's plugin log:

```sh
herdr plugin log list --plugin shahi
```

Only the hash is kept, so it cannot be shown again. A phone paired by code
never types it (below); it is the fallback for typing an address by hand. To
set your own, from the checkout:

```sh
cd "$(herdr plugin list --json | jq -r '.result.plugins[] | select(.plugin_id=="shahi") | .plugin_root')"
SHAHI_ENV_FILE="$(herdr plugin config-dir shahi)/.env" bun run server/scripts/init-secrets.ts --passcode 1234
herdr plugin action invoke shahi.restart
```

Unlike a checkout, the plugin does not let the gate be off: an empty
`PASSCODE_HASH_B64` gets a new passcode on the next herdr start, because this
port is full control of every agent on the machine.

## Reaching it

The sidecar listens on `7171` on loopback and dials out to Shahi's relay
(`docs/relay.md`), so the first pairing code already works from anywhere:
the code carries the relay's address, the phone connects through it, and the
relay sees ciphertext and nothing else — what it does see is that a box with
your `serverId` is online, and the timing and sizes of its frames. The relay
is `https://shahi-relay.yasserd99.workers.dev`, a Cloudflare Worker run by
Shahi's author; the default lives in the plugin's code, not in your files,
and a `RELAY_URL` line in the `.env` always wins:

```sh
echo 'RELAY_URL=' >> "$(herdr plugin config-dir shahi)/.env"           # direct only: the box never dials out
echo 'RELAY_URL=https://…' >> "$(herdr plugin config-dir shahi)/.env"  # your own Worker (docs/relay.md, "Operating the relay")
herdr plugin action invoke shahi.restart
```

Written before the first `restart`, the empty line means the box never
dials out at all. `PORT` and `HOST` go in the same file, the same way:

```sh
echo PORT=7275 >> "$(herdr plugin config-dir shahi)/.env"
herdr plugin action invoke shahi.restart
```

A phone paired by a code that carries the relay connects through the relay
and nothing else. The direct ways in — the app's SSH tunnel to the box, or
`tailscale serve --bg --https=443 http://127.0.0.1:7171` in front of the
loopback bind, then the address typed by hand — are a different pairing,
faster on the same network; the README's Setup section covers both.
**Never `tailscale funnel`.**

## Pairing a phone

```sh
herdr plugin action invoke shahi.pair
```

or **Pair a phone** from herdr's command palette. Either opens a popup inside
herdr that prints the QR (`server/scripts/pair.ts`, run with the plugin's
`.env`), waits for you to scan it, and closes on Enter. On the phone: Connect
→ **Scan a code**. The code works once and for ten minutes; open the popup
again for another phone.

The code carries the relay's address, and the phone uses that and nothing
else. The code's format also wants a direct address, so the box fills it
with the best guess it has — the Tailscale name, the bind address if it is
not loopback, otherwise its own loopback — and a phone that has the relay
ignores it. Without a relay and without a guess, the popup asks you to type
the address first. What the code carries and how the server checks it is in
`pairing.md`.

A keybinding, if you pair often — in herdr's `config.toml`:

```toml
[[keys.command]]
key = "prefix+P"
type = "plugin_action"
command = "shahi.pair"
description = "pair a phone with Shahi"
```

## The actions

All of them run through herdr (which injects the plugin's directories and
socket), from the command palette or:

```sh
herdr plugin action invoke shahi.<action>
herdr plugin log list --plugin shahi        # their output
```

| action | does |
|---|---|
| `pair` | opens the QR popup |
| `status` | service state and pid, the address, the relay and whether the box is on it, what `GET /api/meta` says, how many phones are paired, where everything is. Exit 1 when the API is not answering. |
| `restart` | re-renders the service from the current checkout and `.env`, restarts it, waits up to six seconds for `/api/meta` |
| `stop` | stops the sidecar until the next herdr start or `restart` |
| `logs` | the last 80 lines of the sidecar's log (`tail -f` the file to follow) |
| `uninstall` | the whole uninstall: stops the sidecar, removes the service file, then `herdr plugin uninstall shahi`; keeps the config and state directories |

What `setup` and `restart` have to say — it is running, the passcode the
first time, the lingering command on Linux — also lands in herdr's
notification tray, because the plugin log is where nobody looks.

## Updating

```sh
herdr plugin install iYassr/shahi          # replaces the checkout, rebuilds
herdr plugin action invoke shahi.restart   # or restart herdr
```

herdr has no `plugin update`; reinstalling is the update. Your `.env` and
database are outside the checkout and untouched, and the restart is what
puts the new code in front of the phone — a sidecar keeps the old code in
memory until then.

## Uninstalling cleanly

One action, from the palette (**Uninstall Shahi**) or:

```sh
herdr plugin action invoke shahi.uninstall
```

It stops the sidecar, removes the plist or unit, and then runs `herdr plugin
uninstall shahi` itself — in that order, because `herdr plugin uninstall`
knows nothing about the service the hook installed and would leave it
running from a directory that no longer exists. What stays is the config and
state directories — the passcode hash, the paired phones, the transcripts —
for you to delete by hand if you mean it:

```sh
rm -r "$(herdr plugin config-dir shahi)" ~/.local/state/herdr/plugins/shahi
```

## Developing it

Link a working tree instead of installing; herdr registers it without
running the build commands, so build it yourself:

```sh
bun install && bun run build:web
herdr plugin link /path/to/your/checkout
herdr plugin action invoke shahi.restart     # the startup hook only runs on herdr start
herdr plugin log list --plugin shahi
herdr plugin unlink shahi                    # when done; leaves your files alone
```

Linked or installed, the plugin is global to your user and visible in every
herdr session. To try it without touching a real installation, put
`PORT=7275` in the config directory's `.env` first; the service label and
unit name are fixed (`app.shahi.sidecar`, `shahi.service`), so there is one
Shahi service per user and the last `restart` wins.

`bun test plugin` covers the pure parts: the manifest (every command it names
exists, its `min_herdr_version` is the one CI pins), the rendered plist and
unit for both platforms, the directory layout, and — in `server/lib` — secret
generation and the endpoint guess. The launchd path was run end to end on a
Mac; **the systemd path is rendered and tested but has not been run against a
real systemd**.

## Listing it in the marketplace

herdr's marketplace is an automatic index of public GitHub repositories
carrying the topic `herdr-plugin` whose default branch has a parseable
`herdr-plugin.toml`. Listing Shahi is one repository setting: add the topic
`herdr-plugin` on GitHub. The index refreshes every thirty minutes and
rescans when the default branch moves. Nothing in the code is involved.

## Not done

- **Not run on Linux.** The systemd unit is rendered and asserted, not
  exercised. The first Linux install should check `systemctl --user status
  shahi` and that `loginctl enable-linger` was done.
- **No log rotation.** The log grows until something truncates it; the
  sidecar is quiet, but a box that runs for a year should have `logrotate` or
  `newsyslog` pointed at it.
- **No Windows.** The manifest says so; there is no user-service story for
  it here and herdr's own Windows support is newer than this plugin.
- **A compiled single binary** would remove the bun requirement and the
  build step. That is a release-asset job, not a plugin change.
- **The relay's default is a `workers.dev` hostname.** It is in code, so a
  reinstall can move it — but a custom domain on the Worker (`docs/relay.md`,
  "Operating the relay") is what lets it move without a release.
