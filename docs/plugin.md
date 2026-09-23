# Shahi as a herdr plugin

The way to install the sidecar if you already run herdr — which you do, or
there is nothing for Shahi to show.

```sh
herdr plugin install iYassr/shahi
herdr plugin action invoke shahi.pair
```

The second command opens a popup in herdr's window, so run it from a terminal
inside herdr (or with a herdr window attached). The first time, the popup sets
Shahi up in front of you and prints what that produced — the passcode, and on
Linux the lingering reminder when it applies — then waits for Enter before it
shows the QR. A setup that fails stays on screen until Enter too, with what to
do next, because herdr closes a popup the moment its command exits. Scan the
QR with the app and the phone connects through Shahi's relay from anywhere, so
nothing has to be exposed, tunnelled or typed. That is the whole setup.

`herdr plugin install` fetches the repository with `git`, shows you the
manifest and the commands it will run, runs the build steps and registers the
plugin. The build steps are three: `plugin/releases/requirements.ts`, which
refuses a bun older than 1.3.13 before anything is downloaded, naming the bun
it found and `bun upgrade` (or `brew upgrade bun`); a production install of
only what the plugin's own commands import, `@shahi/server` and
`@shahi/shared` (about 51 packages, about 6 MB, where the whole monorepo was
about a gigabyte); and `plugin/update.ts`, which restarts an existing service
once herdr has committed the install. Nothing is built from the checkout's
`web/`: the service, its manager and the web app it serves come prebuilt in a
signed release.

The setup — a passcode and the keys that go with it, the relay, the approved
release, a user service that supervises it — is done by the plugin's startup
hook on every herdr start, and by the `pair` popup when it finds no service.
It is idempotent: a later run keeps your passcode and restarts the approved
service, independently of the code checked out. The documented ways to run an
action are the CLI above and a key you bind (below); herdr 0.8.2, where this
was measured, had no menu for plugin actions.

## Requirements

- **herdr 0.9.0 or newer** (the manifest's `min_herdr_version`) on **macOS or
  Linux**. Each Shahi release is approved for exact herdr versions — today
  0.9.0 and 0.9.1 — once the live adapter suite passes against them
  ([releases.md](releases.md)). On a herdr no release is approved for, a first
  install still goes ahead with the newest release, in the recovery state:
  pairing and updates work, agent commands are refused, and the popup names the
  herdr it found and the versions the release is approved for. The app offers a
  Shahi update once one is approved for that herdr; installing an approved herdr
  also works.
- **`git`**, which `herdr plugin install` runs to fetch the plugin. A minimal
  Ubuntu does not have it.
- **[bun](https://bun.sh) 1.3.13 or newer.** Every command in the manifest goes
  through `plugin/bun.sh`, which finds bun in the places herdr's PATH may not
  include and otherwise — during `herdr plugin install` only, never from a hook
  or an action — runs bun's own installer into `~/.bun`. That installer also
  adds `~/.bun/bin` to your shell's rc file, as it always does, and needs
  `curl`, `unzip` and `bash`; when one is missing, `bun.sh` prints the
  package-manager line that installs it (`sudo apt-get install -y unzip` on a
  fresh Debian or Ubuntu, the usual one) and asks you to run
  `herdr plugin install iYassr/shahi` again. A bun that is present but older
  than 1.3.13 is never upgraded for you; the first build step says so.
- On a headless Linux box, **lingering** — see *What gets created*.

Installed and verified by hand on Debian 12, Fedora 44, Arch and Ubuntu 26.04
(OrbStack VMs, 2026-09-04), and in daily use on Ubuntu 24.04. On 2026-09-18
the systemd service on each of those four VMs was killed and came back
([the report](relay-recovery-vms-2026-09-18.md)). A fresh-user install on a
clean Ubuntu 26.04 VM in the pre-public-release review is what found the
missing `git` requirement above.

**A distribution without systemd gets no supervised service** — Alpine ships
busybox init and OpenRC and does not package systemd at all, and OpenRC has no
per-user services to port the unit to. Everything else works there, so setup
still writes the secrets and stages the approved release, then prints the
exact command a unit would have run:

```sh
cd <managed root> && exec env HERDR_SOCKET_PATH=… SHAHI_ENV_FILE=… SHAHI_DATA=… PORT=… RELAY_URL=… … SHAHI_MANAGER_ROOT=… <bun> run <managed root>/manager.js >> <log> 2>&1
```

Your own init must run it and restart it whenever it exits: an update exits it
on purpose. `shahi.status` then shows `service none (no systemd)`, `shahi.pair`
works once the sidecar answers, and `shahi.restart` prints the command again.

## What gets created, and where

herdr gives every plugin two directories and keeps them apart from the
checkout, which a reinstall replaces. Nothing that must survive an update is
in the checkout, and nothing the service runs is either.

| | macOS | Linux |
|---|---|---|
| **secrets** — `.env`, mode 0600 | `~/.config/herdr/plugins/config/shahi/.env` | same |
| **data** — SQLite: transcripts, paired phones, push subscriptions, the server's identity | `~/.local/state/herdr/plugins/shahi/shahi.sqlite` | same |
| **log** — the sidecar's stdout and stderr | `~/.local/state/herdr/plugins/shahi/shahi.log` | same |
| **releases** — the manager and the verified releases it runs | `~/.local/state/herdr/plugins/shahi/managed/` | same |
| **service** | `~/Library/LaunchAgents/app.shahi.sidecar.plist` | `~/.config/systemd/user/shahi.service` |
| **checkout** — the plugin's own commands | `herdr plugin list --json` → `plugin_root` | same |

`herdr plugin config-dir shahi` prints the config directory, which is the
one you might edit. The paths above were measured on this Mac; on a machine
with `XDG_*` set they follow it.

The service is what keeps the sidecar alive across herdr restarts, crashes
and reboots — herdr's own startup hooks are one-shot by contract, "not
supervised daemons", so the hook installs the service rather than being it.
The unit is re-rendered on herdr start and after reinstalling. It supervises a
manager outside the checkout; that manager verifies and runs approved releases,
and asks herdr every 30 seconds whether the plugin is still installed and
enabled (see *Uninstalling cleanly*). **On Linux, a headless box needs
`loginctl enable-linger $USER`** once, or the user service stops when your
last SSH session ends — precisely when you would want to reach it from a
phone. The plugin cannot do this for you — it needs sudo on some
distributions — so setup prints the command when lingering is off.

`systemctl --user` needs a user manager to talk to, and a shell without a
login session of its own — `su`, `sudo -iu`, some containers — has none.
Setup then stops with guidance instead of systemd's "Failed to connect to user
scope bus": start herdr from a real login as that user (SSH or a console), or
keep the user's systemd running with `sudo loginctl enable-linger <user>`; if
the shell has no `XDG_RUNTIME_DIR`, `export XDG_RUNTIME_DIR=/run/user/<uid>`
before starting herdr. Then `herdr plugin action invoke shahi.restart`.

The service follows the herdr that ran the hook last: its `HERDR_SOCKET_PATH`
is the one herdr injected, so a named session (`herdr --session work`)
takes the sidecar with it. There is one sidecar per user, not one per
session.

## The passcode

The first setup prints a four-digit passcode, once. Where it lands depends on
what ran that setup: the pair popup shows it on screen, and the startup hook
writes it to herdr's plugin log:

```sh
herdr plugin log list --plugin shahi
```

Only the hash is kept, so it cannot be shown again. A phone paired by code
never types it; it is for signing in over SSH, and to the web app a computer
serves locally. A lost one is replaced:

```sh
herdr plugin action invoke shahi.reset-passcode
herdr plugin log list --plugin shahi        # the new passcode is here
```

That writes a new hash, prints the new passcode once to the plugin log and
restarts the sidecar with it. It is for a forgotten passcode, not a leaked
one: sessions already signed in and paired phones stay as they are (to cut
off a device, revoke it; see [pairing.md](pairing.md)).

Unlike a checkout, the plugin does not let the gate be off: an empty
`PASSCODE_HASH_B64` gets a new passcode on the next herdr start, because this
port is full control of every agent on the machine.

## Reaching it

The sidecar listens on `7171` on loopback and dials out to Shahi's relay
(`docs/relay.md`), so the first pairing code already works from anywhere:
the code carries the relay's address, the phone connects through it, and the
relay sees ciphertext and nothing else — what it does see is that a box with
your `serverId` is online, and the timing and sizes of its frames. The relay
is `https://relay.getshahi.dev`, a Cloudflare Worker run by
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

A moved port costs the app's SSH tunnel, which always forwards to 7171 (the
SSH form has no port field); relay pairing is unaffected.

The port answers only requests whose `Host` is `127.0.0.1`, `localhost` or
`[::1]`, with any port; anything else is a 403 saying to connect through the
relay or an SSH tunnel. That is the DNS-rebinding defence. A reverse proxy
that keeps its own name in `Host` — `tailscale serve` does — works only when
that name is listed, comma-separated and without ports or wildcards, in
`SHAHI_ALLOWED_HOSTS` in the same `.env`; a malformed entry stops the sidecar
from starting.

A phone paired by a code connects through the relay and nothing else. The one
alternative is the app's SSH tunnel to the box, for someone who wants no third
party in the path; [connectivity.md](connectivity.md) covers the choice. There
is no third way in — the sidecar binds loopback and is never given an address
of its own to expose.

## Pairing a phone

```sh
herdr plugin action invoke shahi.pair
```

opens a popup inside herdr that prints the QR (`server/scripts/pair.ts`, run
with the plugin's `.env`), waits for you to scan it, and closes on Enter. If
the sidecar's service is missing — the first time, or after `uninstall` — it
runs the setup first, in the same popup, and waits for Enter before the QR. On
the phone: **Scan QR code**. The code works once and for ten minutes; open the
popup again for another phone.

The QR has a dedicated screen with a short expiry and close hint. Long links and
setup output do not push it into scrollback. It redraws when the terminal is
resized; if the window cannot fit a complete code, it asks for more room instead
of displaying an unscannable partial QR. The popup uses the available height.
**T** then Enter swaps the QR for the same code as a
`https://getshahi.dev/pwa/#pair=…` link, for a machine the phone cannot see —
a server you reach over SSH, where the QR is on the wrong screen; T and Enter
again brings the QR back, and Enter alone closes.

The popup automatically copies the pairing code to the system clipboard on
macOS (`pbcopy`) and Linux desktops (`wl-copy`, `xclip`, or `xsel`, when
available), and reports whether copying succeeded. Paste it into the browser
app at **https://getshahi.dev/pwa/** or the native app. The code is sent to the
clipboard utility over stdin, never as a shell command or process argument.

The popup needs a herdr window. With no client attached — a headless server —
herdr's CLI still exits successfully, and the plugin log holds the reason
(`no active workspace`) and a command that prints the code as text instead:

```sh
cd <plugin root> && SHAHI_ENV_FILE=<config dir>/.env bun run server/scripts/pair.ts --code-only
```

It prints only the one-time code, without a QR or clipboard change;
`--no-copy` keeps the QR and leaves the clipboard alone. The relay it puts on
the code is the one the running sidecar reports over loopback (`/api/meta`),
not a reading of the `.env`, so it works with the plugin's default relay,
which is never written there. It fails with "Is it running?
herdr plugin action invoke shahi.status" when the sidecar does not answer.

The code carries the relay's address, the box's id and a one-time secret — and
nothing else. A box with `RELAY_URL=` empty has no address to put on a code,
so it mints none: "This box dials no relay (its RELAY_URL is empty)", and
reach it over SSH. What the code carries and how the server checks it is in
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
socket):

```sh
herdr plugin action invoke shahi.<action>
herdr plugin log list --plugin shahi        # their output
```

| action | does |
|---|---|
| `pair` | opens the QR popup, setting Shahi up first when there is no service |
| `status` | service state and pid, the address, the relay and whether the box is on it, what `GET /api/meta` says (the release version and herdr's), how many phones are paired, where everything is. Exit 1 when the API is not answering. |
| `restart` | re-renders the managed service from `.env`, restarts it, and requests a compatible approved update; with no systemd, prints the command to run |
| `reset-passcode` | replaces the passcode, prints the new one once to the plugin log, and restarts; sessions and paired phones stay |
| `stop` | stops the sidecar. The service stays installed, so it comes back at the next herdr start, `restart`, or login (on Linux with lingering, the next boot) |
| `logs` | the last 80 lines of the sidecar's log, the private operations log and `update.log` (`tail -f` the file to follow) |
| `uninstall` | the whole uninstall: stops the sidecar, removes the service file, then `herdr plugin uninstall shahi`; keeps the config and state directories |

`herdr plugin action invoke` prints a JSON record, not the action's output;
the output is in the log above. What `setup` and `restart` have to say — it
is running, where the passcode is, the lingering command on Linux, and a
setup that failed — is also shown as a herdr notification when
`[ui.toast] delivery` is on in herdr's `config.toml` (it is off by default).
The notification never carries the passcode digits: a toast reaches every
attached client. The `pair` popup is the one place the first run's output is
simply on screen.

## Updating

```sh
herdr plugin install iYassr/shahi          # rebuilds, then automatically restarts Shahi
```

The plugin is the installer and service manager. It selects the latest compatible
signed Stable release on first install. Reinstalling updates the manager and
requests an approved computer update; code running in production comes from the
verified release package, outside the mutable checkout.

In the phone or web app, choose a computer and use **Update computer** when an
update is available. Settings also offers **Check for updates** and Stable/Beta
channels. The app shows progress and reconnects with its existing pairing.
Downloads are verified, staged and checked after restart. Failed activation
restores the previous release. herdr itself is never restarted by this updater.
See [the compatibility and release policy](releases.md).

The old pre-managed service needs one plugin reinstall to gain these controls.
Your `.env`, server identity, paired devices and database stay in place. The
private `update.log` in `herdr plugin config-dir shahi` reports actual readiness;
`shahi.logs` includes it. A failed download leaves the working service alone.

The current mobile and web clients require relay protocol 2. Update Shahi on
each paired computer when installing this release; updating herdr alone does
not update its Shahi plugin. A server still using relay protocol 1 can appear
connected to the relay while dropping a new app's connection. Existing paired
device credentials survive the plugin update.

## Uninstalling cleanly

One action:

```sh
herdr plugin action invoke shahi.uninstall
```

It removes the plist or unit, stops the sidecar, and then runs `herdr plugin
uninstall shahi` itself. The service runs from the state directory, not the
checkout, so uninstalling the plugin does not take it away by itself: herdr
has no uninstall hook and knows nothing about the service. What ends it is the
manager, which asks herdr every 30 seconds whether this plugin is still
installed and enabled for the configuration it was installed from, and on a
"no" confirmed five seconds later removes its own service. So a plain
`herdr plugin uninstall shahi` or `herdr plugin disable shahi` stops Shahi
within about 40 seconds; the action is the immediate path. Any answer short of
a clear "no" — herdr missing, a registry being rewritten, a different
configuration root — leaves the service running. If herdr is gone altogether,
remove the service by hand (the README has the commands).

What stays is the config and state directories — the passcode hash, the
paired phones, the transcripts — for you to delete by hand if you mean it:

```sh
rm -r "$(herdr plugin config-dir shahi)" ~/.local/state/herdr/plugins/shahi
```

## Developing it

Link a working tree instead of installing; herdr registers it without
running the build commands, so install its dependencies yourself:

```sh
bun install
herdr plugin link /path/to/your/checkout
herdr plugin action invoke shahi.restart     # the startup hook only runs on herdr start
herdr plugin log list --plugin shahi
herdr plugin unlink shahi                    # when done; leaves your files alone
```

A link runs the plugin's own commands from your tree, but the service they
install still runs the approved signed release from `managed/`, not your tree's
server. To try server changes, run the server from the checkout (`bun run dev`,
with its own `.env` and a spare `PORT`).

Linked or installed, the plugin is global to your user and visible in every
herdr session. To try it without touching a real installation, put
`PORT=7275` in the config directory's `.env` first; the service label and
unit name are fixed (`app.shahi.sidecar`, `shahi.service`), so there is one
Shahi service per user and the last `restart` wins.

`bun test plugin` covers the pure parts: the manifest (every command it names
exists, its `min_herdr_version` is the one CI pins), the rendered plist, unit
and unsupervised command, the order `remove()` runs in, the registration check,
the directory layout, and — in `server/lib` — secret generation. The launchd
path runs end to end on the author's Mac, and the systemd path on the Linux
machines listed under *Requirements*.

## Listing it in the marketplace

herdr's marketplace is an automatic index of public GitHub repositories
carrying the topic `herdr-plugin` whose default branch has a parseable
`herdr-plugin.toml`. Listing Shahi is one repository setting: add the topic
`herdr-plugin` on GitHub. The index refreshes every thirty minutes and
rescans when the default branch moves. Nothing in the code is involved.

## Not done

- **Linux coverage is by hand.** The distributions under *Requirements* were
  installed and exercised once each; no CI job installs the plugin on a fresh
  machine, and both Linux bugs found so far were a first install away. A
  headless deployment still needs `loginctl enable-linger` as described above.
- **No rotation of `shahi.log`.** The sidecar's stdout log grows until
  something truncates it (the private `operations.jsonl` beside it does
  rotate); the sidecar is quiet, but a box that runs for a year should have
  `logrotate` or `newsyslog` pointed at it.
- **No Windows.** The manifest says so; there is no user-service story for
  it here and herdr's own Windows support is newer than this plugin.
- **A compiled single binary** would remove the bun requirement and the
  build step. That is a release-asset job, not a plugin change.
- **The relay's default is one anchor for every install.** It is a domain the
  project owns (`relay.getshahi.dev`), so it can be repointed at another host
  without a release and cannot be reclaimed by anyone else — but every default
  box still converges on it. `RELAY_URL` is the way off.
