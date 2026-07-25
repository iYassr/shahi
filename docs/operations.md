# Running it

What is deployed, where its state lives, and what to do when something is wrong.
Written for the moment you need it rather than for reading through.

## The shape of a deployment

```
phone ──HTTPS 443──> tailscaled ──proxy──> 100.x.y.z:7171 (bun) ──unix socket──> herdr
       (tailnet only)                       systemd --user
```

Two addresses reach the same server, deliberately:

- **`http://<tailnet-ip>:7171`** — direct, no TLS. Convenient, and what the
  native app was pointed at first.
- **`https://<host>.<tailnet>.ts.net`** — `tailscale serve` terminating TLS in
  front of the same port. This one is a *secure context*, which is the only
  reason notifications can work at all: browsers refuse to register a service
  worker off one, and on iOS the service worker is the entire delivery path for
  Web Push.

Use the HTTPS name on the phone. The direct port is a fallback for when DNS is
misbehaving — which is worth knowing, because "the port works but the name does
not" is a DNS symptom, not a server one.

## Standing it up

```sh
curl -fsSL https://raw.githubusercontent.com/iYassr/HerdrUI/master/install.sh | bash
```

Idempotent: run it again to upgrade, and it keeps the passcode you already have.
It refuses to repoint an existing installation somewhere else unless you pass
`HERDRUI_FORCE=1`.

Then, once, for TLS:

```sh
sudo tailscale serve --bg --https=443 http://<tailnet-ip>:7171
```

That config lives in tailscaled's state and survives reboots. Check it with
`tailscale serve status`.

**Never `tailscale funnel`.** Funnel puts a service on the public internet, and
this one can run arbitrary commands as you.

## Where things live

| what | where |
|---|---|
| the app | `~/.local/share/herdrui/app` (or wherever you cloned it) |
| secrets | `.env` in that directory, mode 0600 — never commit it |
| database | `~/.local/share/herdrui/herdrui.sqlite` — push subscriptions, transcripts |
| uploads | `~/.local/share/herdrui/uploads` — files sent from the phone |
| service | `~/.config/systemd/user/herdrui.service` |

The database is not precious: transcripts are a convenience and subscriptions
re-register when the phone next opens the app. Deleting it costs a re-grant of
notifications, nothing more.

## Everyday commands

```sh
systemctl --user status herdrui        # is it up
journalctl --user -u herdrui -f        # what it is doing
systemctl --user restart herdrui       # after a rebuild
bun run build:web && systemctl --user restart herdrui   # the whole deploy
```

`loginctl enable-linger $USER` is what keeps the service alive when you are not
logged in — without it, it stops the moment your last SSH session ends, which is
exactly when you would want to reach it from a phone. The installer does this.

## What healthy looks like

Startup prints the version, the address, and what it found:

```
herdr 0.7.5 (protocol 17) at /home/you/.config/herdr/herdr.sock
listening on http://100.x.y.z:7171
  11 workspaces, 47 panes, 14 agents (0 blocked)
  passcode required
  push enabled, 2 subscription(s)
```

A protocol other than 17 prints a loud warning. herdr's schema is unversioned
for third parties, so a mismatch means something in `server/lib/herdr-schema.ts`
may now be wrong — regenerate with `bun run gen:types` and read the diff.

Bound off loopback, it also warns that the address is not a secure context. That
is expected here, and answered by `tailscale serve`.

## When something is wrong

**The phone cannot reach it.** Work outwards: `curl http://127.0.0.1:7171/api/auth/status`
on the box, then the tailnet IP, then the HTTPS name. If the IP works and the
name does not, it is DNS — turn on "Use Tailscale DNS" in the phone's Tailscale
app. If neither works, check `systemctl --user status herdrui`.

**The dashboard is stale but says LIVE.** The socket died without saying so. The
server heartbeats every 20s and the client gives up after 50s of silence, so this
should self-correct; if it does not, the watchdog in `web/src/api.ts` is the
place to look.

**Everything looks broken after a deploy.** The app compares its own bundle
against the served one when it comes to the foreground and reloads if they
differ, so this should not happen — but backgrounding and reopening forces it.

**An agent stopped responding to the app.** Check the pane in herdr directly.
The app sends keystrokes; it cannot make an agent read them, and a pane whose
process has exited accepts input into nothing.

## Rotating the passcode

```sh
bun run server/scripts/init-secrets.ts --passcode <digits>
systemctl --user restart herdrui
```

Only the bcrypt hash is stored; the plaintext lives nowhere. The session secret
is left alone, so other devices stay signed in — sign each one in again with the
new passcode when convenient.

Note that the passcode `4821` appears in this repository's early history, in a
script that hardcoded it as a default. Rotating is the clean fix if that matters
to you.

## Backing up

`.env` is the only thing that cannot be regenerated: it holds the session secret,
the passcode hash, and the VAPID keypair. Lose the VAPID keys and every existing
push subscription becomes undeliverable, and each device must re-grant
notifications.
