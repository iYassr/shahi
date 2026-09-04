# Notifications: what is possible where

The point of the whole project is a phone that taps you on the shoulder when an
agent is waiting. Getting there took an afternoon of finding out which
combinations are actually possible, most of which fail silently rather than
telling you why. This is that map.

## The short version

| how you opened it | notifications | what you need |
|---|---|---|
| Safari tab on iOS | **no** | nothing will help — the API is not there |
| PWA on the home screen, over HTTPS | **yes** | `tailscale serve`, then Add to Home Screen |
| PWA over plain HTTP | **no** | not a secure context, so no service worker |
| Expo Go | **no** | impossible at any SDK since 53 |
| a development build | yes | EAS project id, and a paid Apple account |
| Android, any of the above | easier | no home-screen requirement |

## Web Push on iOS, which is the one that works

Three things must all be true, and the failure of any of them is quiet:

1. **A secure context.** Browsers refuse to register a service worker off one,
   and on iOS the service worker is the entire delivery path. Plain
   `http://100.x.y.z:7171` cannot work. `tailscale serve` in front of the same
   port can.
2. **Installed to the home screen.** iOS grants Web Push only to a PWA launched
   from its icon. In a Safari tab the button appears to work and nothing ever
   arrives — which is why the app detects this and says "Add to Home Screen"
   rather than offering a button that cannot work.
3. **`Notification` exists at all.** Outside an installed app on iOS the global
   is simply absent. Touching it throws, and for the life of this project that
   threw during first render and left the whole dashboard blank in a Safari tab.
   Guarded now; be careful adding another reference.

Setup, once:

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:7171
```

Then on the phone: open `https://<host>.<tailnet>.ts.net`, enter the passcode,
Share → Add to Home Screen, open it from the icon, and turn notifications on.
There is a "Send a test" in the app; use it before you rely on it.

## What fires one

Only a transition **into** `blocked`, debounced 5 seconds per pane. `done` was
tempting and rejected: a finished turn is not urgent, and firing on both trains
you to ignore the notification. The baseline snapshot at startup reports every
pane's status with no previous value, and those are deliberately not notified —
waking a phone for agents that were already waiting before the process started is
noise.

The payload carries the pane id, so tapping the notification opens that pane
rather than the list.

## The native app, and what is left to prove

Native push is wired end to end: a Settings toggle calls `enablePush()`, which
registers an Expo token with `/api/push/expo`; the server sends on the
transition to `blocked` and drops tokens Expo reports as `DeviceNotRegistered`;
tapping a notification routes to its pane. None of it is missing.

What is missing is a device. The history is why it took so long:

- **Expo Go cannot receive remote push since SDK 53.** Not a configuration
  problem — the capability was removed. The app detects Expo Go and says so
  rather than failing obscurely.
- **A development build needs an EAS project id.** That is set in `app.json`
  already.
- **Installing on an iPhone needs signing.** Free signing via Xcode works for
  seven days at a time, but personal teams have no `aps-environment` entitlement,
  so a free-signed build cannot register for APNs at all. Push on iOS needs the
  paid Apple Developer Program.

That last point is settled: a paid Apple account arrived in August 2026, and
with it the decision that native is where this goes. The PWA is archived.

So the only thing standing between this and working push is running it on a
real iPhone. The simulator reports `Device.isDevice === false` and refuses to
mint a token, so nothing here can be proven from a Mac alone — the
`expo_push_token` table is still empty, and the first token to land in it is
the proof. Do not go looking for missing wiring; flip the toggle on a phone.

## Server side

Two independent channels, either usable without the other:

- **Web Push** needs VAPID keys, generated into `.env` by `init-secrets.ts`.
  Subscriptions live in SQLite; endpoints the push service reports as gone
  (404/410) are dropped, because a stale subscription otherwise fails on every
  notification forever.
- **Expo push** needs no keys. Tokens live in SQLite; a token Expo reports as
  `DeviceNotRegistered` is dropped for the same reason.

Losing the VAPID keypair makes every existing subscription undeliverable and
requires each device to grant permission again. It is the one thing in `.env`
worth backing up.
