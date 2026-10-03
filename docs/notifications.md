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

The payload carries the pane id, its occupant's `instanceId`, and the computer's
`serverId`. A tap opens that conversation on that computer. If another program
has taken the pane, Shahi says the conversation ended and offers an explicit
action to open what runs there now. In a browser whose app is
already open, the service worker posts the pane and computer to the page, which
routes in place without a reload, so drafts and session-only pairings survive;
a page from an older release that does not answer within three seconds is
navigated to the pane as before.

## Approving from the notification

On an iPhone paired with a computer through the relay, a notification for a
waiting agent shows what it asks — "Do you want to proceed?", the command
under it — and offers the answers as actions: press and hold the
notification (or expand it on the lock screen) and choose one. Nothing in
between can read the question. Competing apps have had this; the owner's
constraint was that Expo and Apple must not see the prompt in clear text.

How it works:

1. **A key per registration.** When notifications are turned on for a relay
   computer whose handshake offers `push-actions`, the app makes 32 random
   bytes (`lib/push-keys.ts`) and sends them with the Expo token to
   `/api/push/expo` as `pushKey`, over the already encrypted relay link. The
   computer keeps it with that registration only when the registration
   belongs to a paired device; every path that drops a registration —
   revocation, sign-out, `DeviceNotRegistered`, a replaced token, a
   registration sent again without a key — drops the key with it, because it
   is a column of the same row. An older computer ignores the field; an older
   app sends none and keeps the plain notification.
2. **Sealed on the computer.** For a phone with a key, the notification's
   words — the space, the conversation, the question with its context — and
   the answers go inside an AES-256-GCM box (`server/lib/push-seal.ts`) with a
   fresh nonce, whose associated data names the format, the computer and the
   pane. Outside the box Expo and Apple carry only the content-free words "An
   agent needs you / Tap to see what it is asking.", the pane id and server id
   a tap routes by, a key id (the first 8 bytes of the key's SHA-256) and
   `mutableContent`. The box is read from a fresh read of the pane when the
   agent blocks, the same read the card's is, so its prompt id is the one
   `/answer` holds current.
3. **Opened on the phone.** The Notification Service Extension
   (`mobile/plugins/notification-service`, added to the Xcode project by
   `plugins/with-notification-service.cjs`) finds the key by its id in a
   keychain access group it shares with the app and nothing else, opens the
   box with CryptoKit, and replaces the words. The answers become a
   notification category of their own, named by its buttons. If anything
   about the box is wrong — no key, another key, a changed byte, a box moved
   to another pane's notification — the content-free words are what shows,
   with no buttons, and a tap opens the pane as before. The extension also
   strips any category or answer that arrived outside the box, so a push
   service cannot add buttons.
4. **Answered by the server.** An action opens the app (see below), which
   selects that computer, opens the pane and posts to `/api/panes/:id/answer`
   exactly what a card posts: the option's index and the parser's own label,
   the question and context when they fitted in the box, the prompt id and the
   occupant. The server decides as it does for a card, against a fresh read of
   the screen. When the question had already moved on (`prompt_gone`,
   `prompt_changed`) nothing is pressed and the app says so in the computer's
   words ("Not answered: …"), with the pane showing what is asked now.

What is offered: up to three of the prompt's answers, labelled as the card
labels them (`shownLabels`, so "Yes, proceed (y)" is "Yes, proceed"). Never an
answer that opens a text field. Past three it is the first two and the last,
because the agents measured put the plain approval first and the refusal last
(Claude Code's Bash, WebFetch and MCP dialogs end in "No"). Anything else is a
tap away in the app.

### Why the actions open the app

An action without `.foreground` wakes the app in the background to handle
it. Measured on the iOS 26.5 simulator (build of 3 October 2026, a JavaScript
category whose action does not open the app, beacons to the Mac):

- **Suspended app:** the action reached JavaScript 0.2 s after the tap, and
  the app was suspended again at once. Timers set for 1 to 28 s later ran
  only when the app next came to the foreground, a minute later.
  expo-notifications calls the system's completion handler as soon as it has
  passed the response on, which is what tells iOS the app is done.
- **Killed app:** nothing ran. No launch, no response, in the 33 s watched.

An answer needs the relay link and up to a few seconds of the computer's
time (it waits for the agent to repaint), so a background action would have
answered sometimes, and sometimes only on the next launch, minutes later.
The actions are `.foreground` and `.authenticationRequired`: one tap from the
notification, after unlocking, and the person sees the answer land or be
refused.

### Who gets it, and limits

- **Relay-paired phones only.** An SSH computer, or a passcode sign-in, keeps
  the plain notification: its registration expires with the session, and an
  action has to reach the computer, which for SSH means a tunnel that cannot
  be assumed from a notification. The server stores no key for a passcode
  session even if one is sent.
- **Turning notifications on makes the key.** A phone that turned them on
  before this feature keeps plain notifications until they are turned off
  and on again.
- **Size.** APNs allows 4 KB. The sealed text is held to 2 KB (about 3 KB on
  the wire): the words are cut on character boundaries; the answer is never
  cut, since `/answer` compares labels exactly, so for a prompt whose context
  does not fit (an edit's diff) the question and context are left out of the
  answer (the prompt id already names that appearance of the question), and
  if the labels alone do not fit there are no buttons.
- **Thirty-two sets of buttons** are kept registered; past that the older
  ones are dropped and a notification still on screen from then loses its
  buttons, not its tap.
- **The key is readable after the first unlock**, so a notification that
  arrives on a locked phone can be opened; it opens notifications and
  nothing else. It is removed when notifications are turned off or the
  computer is signed out of.
- **Browsers** get the question and its context too, inside Web Push's own
  encryption (RFC 8291), and no buttons: iOS shows none for web push.

### Testing it

`xcrun simctl push` does not run a Notification Service Extension: measured
on the iOS 26.5 simulator (October 2026), SpringBoard adds the simulated
request straight to its pipeline ("Adding notification request … to
destinations") and no extension process starts, so a sealed payload pushed
that way shows the content-free words. That simulator's push daemon also had
no connection to APNs ("Connected on 0 interfaces"), so it got no device token
and no real push. What was checked there instead: the extension embedded and
registered, its entitlements naming only the shared group; the app writing
the key into that group with the after-first-unlock class, and removing it
when notifications are turned off; and the extension's own class, run in the
app process on a real sealed payload, showing the question and offering its
answers, and the content-free words with no buttons for a changed box, an
unknown key and a category forged outside the box. An action then opened the
app and answered the agent through the relay. The extension running in its
own process on a real push needs a physical iPhone.
`mobile/plugins/notification-service/tests/run.sh` opens the computer's
known-answer vector with the extension's Swift on a Mac.

## The native app, and what is left to prove

Native push is wired end to end: a Settings toggle calls `enablePush()`, which
registers an Expo token with `/api/push/expo`; the server sends on the
transition to `blocked` and drops tokens Expo reports as `DeviceNotRegistered`;
tapping a notification routes to its pane. None of it is missing.

The app tells iOS to show a notification that arrives while it is open as soon
as it launches, not when Settings is opened: without that handler,
expo-notifications answers "show nothing", and every notification that arrived
with the app open after a relaunch vanished. The phone keeps the token it
registered with each computer in the keychain, per SSH endpoint or per paired
relay device, so Settings reads On after a relaunch and can turn notifications
off, which removes the registration from the computer before the phone forgets
the token. An SSH computer signs in with a new passcode session on every launch
and reconnect, and carries its saved token to each one, because a passcode
session's registrations end when it expires.

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
workspace label and the body the pane's dashboard title, followed in a
browser's and a sealed notification by the question and its context, each
cut on a character boundary to stay well inside the 4 KB both services allow.
A phone that gave a push key gets those words sealed, with content-free words
outside (see "Approving from the notification"). Failures
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
