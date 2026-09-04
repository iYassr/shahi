# Running it

What is deployed, where its state lives, and what to do when something is wrong.
Written for the moment you need it rather than for reading through.

## The shape of a deployment

The plugin's startup hook installs a user service that supervises the sidecar;
the sidecar owns herdr's unix socket and answers the phone.

```
phone ──sealed frames──> relay ──> sidecar (bun) ──unix socket──> herdr
                                   launchd or systemd --user
```

The relay is the default and needs nothing configured: the box dials out and
holds the connection open, so there is no inbound port and no domain. The one
alternative is an SSH tunnel to the same loopback bind, for someone who wants
no third party in the path. See [connectivity.md](connectivity.md) for the
choice, and [relay.md](relay.md) for what the relay can and cannot see.

`RELAY_URL=` (empty) in the plugin's `.env` opts out of the relay entirely; the
phone then reaches the box over SSH.

**Do not put this port on a network.** Both transports arrive at `127.0.0.1`,
so nothing needs it exposed — and it runs arbitrary commands as you. That goes
double for `tailscale funnel`, which would publish it to the internet.

## Standing it up

```sh
herdr plugin install iYassr/shahi
herdr plugin action invoke shahi.pair
```

The first builds and registers the plugin; the second installs the service if it
is missing and prints a pairing QR. Reinstalling upgrades in place and keeps
your passcode.

The service always restarts on install, deliberately: `enable --now` does
nothing to a running service, so an in-place upgrade once left the old code
running from memory while looking applied.

**On a headless Linux box, run `loginctl enable-linger $USER` once.** Without
it the user service stops when your last SSH session ends — exactly when you
would want to reach it from a phone. The plugin cannot do this for you because
it needs sudo on some distributions.

## Where things live

herdr gives the plugin two directories and keeps them apart from the checkout,
so an upgrade never touches your secrets or your data.

| what | where |
|---|---|
| the checkout | `$HERDR_PLUGIN_ROOT` — replaced on upgrade, never edit |
| secrets | `$HERDR_PLUGIN_CONFIG_DIR/.env`, mode 0600 |
| database | `$HERDR_PLUGIN_STATE_DIR/shahi.sqlite` — devices, push, transcripts |
| log | `$HERDR_PLUGIN_STATE_DIR/shahi.log` |
| service | `~/Library/LaunchAgents/app.shahi.sidecar.plist`, or `~/.config/systemd/user/shahi.service` |

`herdr plugin action invoke shahi.status` prints the resolved paths, which beats
guessing at them.

The database is not precious: transcripts are a convenience, and a phone
re-pairs. The `.env` is the one thing that cannot be regenerated — it holds the
session secret, the passcode hash, the relay identity key and the VAPID keypair.
Lose the relay key and the box gets a new `serverId`, so every phone pairs
again.

## Everyday commands

```sh
herdr plugin action invoke shahi.status     # is it up, and where
herdr plugin action invoke shahi.logs       # what it is doing
herdr plugin action invoke shahi.restart    # after a change
herdr plugin action invoke shahi.pair       # add a phone
herdr plugin action invoke shahi.stop       # stop the service
herdr plugin action invoke shahi.uninstall  # service first, then the plugin
```

These work on both platforms. The underlying `launchctl` and `systemctl --user`
commands still work if you prefer them, but the actions are what the plugin
keeps in step.

**Rebuild and restart after touching `web/`.** The sidecar serves `web/dist`,
so an unbuilt change is invisible.

## What healthy looks like

Startup prints the version, the address, and what it found:

```
herdr 0.8.2 (protocol 20) at /home/you/.config/herdr/herdr.sock
listening on http://127.0.0.1:7171
  11 workspaces, 47 panes, 14 agents (0 blocked)
  passcode required
  relay: connected
```

A protocol other than 20 prints a loud warning. herdr's schema is unversioned
for third parties, so a mismatch means something in `server/lib/herdr-schema.ts`
may now be wrong — regenerate with `bun run gen:types` and read the diff.

## When something is wrong

**The phone cannot reach it.** Work outwards. On the box,
`curl http://127.0.0.1:7171/api/meta` should answer. Then check
`shahi.status` for the relay state. If the relay is connected and the phone
still cannot reach it, the phone is probably paired to a different `serverId` —
re-pair. On the SSH path, check that the tunnel opens at all: a changed host
key is refused on purpose, and is reported as that rather than as a dead box.

**The app says the server is too old, or too new.** The contract version is
negotiated: `GET /api/meta` says what the sidecar speaks and every request
carries `x-shahi-api`. A mismatch is a 426 whose text names the side to update.
Update the sidecar with `herdr plugin install iYassr/shahi`.

**An agent stopped responding to the app.** Check the pane in herdr directly.
The app sends keystrokes; it cannot make an agent read them, and a pane whose
process has exited accepts input into nothing.

**The service looks installed but runs old code.** It follows the herdr that
ran the hook last. If you use named sessions, the one that started most
recently owns it — `shahi.status` prints the socket it is attached to.

## Rotating the passcode

```sh
bun run server/scripts/init-secrets.ts --passcode <digits>
herdr plugin action invoke shahi.restart
```

Only the bcrypt hash is stored; the plaintext lives nowhere. The session secret
is left alone, so paired devices stay signed in. To revoke one phone instead,
use Settings in the app — revocation takes effect on its next request and on its
open socket.

Note that the passcode `4821` appears in this repository's early history, in a
script that hardcoded it as a default. Rotating is the clean fix if that matters
to you.

## Backing up

Back up `$HERDR_PLUGIN_CONFIG_DIR/.env`. Everything else regenerates: the
checkout comes from `herdr plugin install`, and the database costs a re-pair and
a re-grant of notifications.
