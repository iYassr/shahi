# Notifications: what is possible where

The point of the whole project is a phone that taps you on the shoulder when an
agent is waiting. Getting there took an afternoon of finding out which
combinations are actually possible, most of which fail silently rather than
telling you why. This is that map.

## The short version

| how you opened it | notifications | what you need |
|---|---|---|
| Safari tab on iOS | **no** | nothing will help — the API is not there |
| hosted PWA (`getshahi.dev/pwa`) on the home screen | **yes** | pair with **Remember this browser**, then Add to Home Screen |
| the computer's own web app on the home screen, over HTTPS | **yes** | a proxy such as `tailscale serve`, its name in `SHAHI_ALLOWED_HOSTS`, then Add to Home Screen |
| PWA over plain HTTP | **no** | not a secure context, so no service worker |
| Expo Go | **no** | impossible at any SDK since 53 |
| a development build | yes | EAS project id, and a paid Apple account |
| Android, any of the above | easier | no home-screen requirement |

## Web Push on iOS, which is the one that works

Three things must all be true, and the failure of any of them is quiet:

1. **A secure context.** Browsers refuse to register a service worker off one,
   and on iOS the service worker is the entire delivery path. The hosted PWA
   at `https://getshahi.dev/pwa/` is one, and reaches the computer through the
   relay. For the web app a computer serves itself, plain
   `http://100.x.y.z:7171` cannot work; `tailscale serve` in front of the same
   port can.
2. **Installed to the home screen.** iOS grants Web Push only to a PWA launched
   from its icon. In a Safari tab the button appears to work and nothing ever
   arrives — which is why the app detects this and says "Add to Home Screen"
   rather than offering a button that cannot work.
3. **`Notification` exists at all.** Outside an installed app on iOS the global
   is simply absent. Touching it throws, and for the life of this project that
   threw during first render and left the whole dashboard blank in a Safari tab.
   Guarded now; be careful adding another reference.

With the hosted PWA: open `https://getshahi.dev/pwa/`, pair with **Remember
this browser** selected (a session-only pairing cannot keep a subscription),
Share → Add to Home Screen, open it from the icon, and turn notifications on in
Settings. Neither app has a test button (the server's `POST /api/push/test`
has no caller in either client), so check delivery with a dedicated test agent
that you make wait for an answer before you rely on it.

With the computer's own web app, setup once:

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:7171
echo 'SHAHI_ALLOWED_HOSTS=<host>.<tailnet>.ts.net' >> "$(herdr plugin config-dir shahi)/.env"
herdr plugin action invoke shahi.restart
```

The second line is needed because `tailscale serve` keeps the tailnet name in
`Host`, and the sidecar refuses any `Host` but loopback unless the owner lists
it: that check is the DNS-rebinding defence. Then on the phone: open
`https://<host>.<tailnet>.ts.net`, enter the passcode, Share → Add to Home
Screen, open it from the icon, and turn notifications on.

A browser gets notifications from one computer at a time: each computer has its
own VAPID key, and every computer paired in the hosted PWA shares its one
service-worker scope. Turning them on for a second computer asks before moving
them. Turning them off removes only the current computer's registration, and
unsubscribes the browser only when the subscription was made with that
computer's key.

## What fires one

Only a transition **into** `blocked`, at most one per pane every 5 seconds.
`done` was tempting and rejected: a finished turn is not urgent, and firing on
both trains you to ignore the notification. The first snapshot after the
sidecar starts reports every pane's status, and those are deliberately not
notified — waking a phone for agents that were already waiting before the
process started is noise. A pane first seen later, already blocked (a new agent
that blocks within one snapshot, a pane restored by a herdr restart), is
notified: only that first snapshot is the baseline.

A block inside the 5-second window is not dropped: when the window ends the
pane is checked again and notified if it is still waiting. And a pane that was
answered and blocked again between two 3-second snapshots, with nothing in
between to say so, is caught by herdr's `state_change_seq`: measured on 0.9.1
it is a session-wide counter that advances on every status change and on
nothing else, so a pane still blocked with a higher number has a new question.

The payload carries the pane id and the computer's `serverId`, so tapping the
notification opens that pane rather than the list. In a browser whose app is
already open, the service worker posts the pane and computer to the page, which
routes in place without a reload, so drafts and session-only pairings survive;
a page from an older release that does not answer within three seconds is
navigated to the pane as before.

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

Native and web are both maintained. Their notification channels need separate
end-to-end checks: native on a signed physical iPhone, and Web Push in a
supported browser or installed PWA.

The September 2026 simulator run did not establish real APNs delivery. Verify
that enabling notifications creates an owned `device_expo_push_token` row,
then lock the phone, trigger a request in a dedicated test agent, and open the
notification. Do not infer delivery from simulator or component-test success.

## Server side

Two independent channels, either usable without the other:

- **Web Push** needs VAPID keys, generated into `.env` by `init-secrets.ts`.
  Subscriptions live in SQLite; endpoints the push service reports as gone
  (404/410) are dropped, because a stale subscription otherwise fails on every
  notification forever.
- **Expo push** needs no keys. Tokens live in SQLite; a token Expo reports as
  `DeviceNotRegistered` is dropped for the same reason.

Both channels send with a one-hour time-to-live and high priority, so a phone
that was offline is not told about a question answered long ago; Web Push also
sets a topic (a hash of the computer and pane) so a newer notification for a
pane replaces one still queued for an offline browser. The title is the
workspace label and the body the pane's dashboard title, each cut on a
character boundary to stay well inside the 4 KB both services allow. Failures
are logged without content and counted in `/api/diagnostics`; see
`docs/operations.md`.

Losing the VAPID keypair makes every existing subscription undeliverable and
requires each device to grant permission again. It is the one thing in `.env`
worth backing up.

## Registration ownership

Registrations belong to the paired device or passcode session that enables
them. Revoking a device removes its Expo and browser registrations immediately;
server-side logout removes the signing-out owner's registrations as well. A
passcode session's registrations also end when the session expires; the app
registers again when it signs in again. Each owner holds one registration per
channel: a new token or subscription replaces the owner's old one. Expo
messages go out in requests of at most 100, Expo's own limit.
The September 2026 ownership update discards older unowned registrations:
enable notifications again after upgrading. This does not change pairing keys
or delete agent transcripts.

Notifications include the originating computer’s identity. Tapping one selects that
computer before opening its pane, on native and hosted web. If that computer is no
longer paired, the computer chooser opens; a pane ID is never assumed to belong to
the currently selected machine.
