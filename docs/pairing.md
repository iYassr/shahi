# Pairing a phone by scanning a code

How a phone is introduced to a Shahi server without typing an address or a
passcode, and what that buys beyond convenience: a session that belongs to a
*device*, which can be seen and revoked. This is step 2 of the build order in
`connectivity.md`. Pairing is a relay act: a code carries the relay's address,
the box's id and a one-time secret, which is what makes the first QR work from
anywhere. A box with no relay mints no codes and is reached over SSH with the
passcode instead.

## Using it

On the server, with Shahi installed as the herdr plugin, from a terminal inside
herdr:

```sh
herdr plugin action invoke shahi.pair
```

It opens a popup in herdr's window with the QR, and copies the code to the
clipboard where it can. **T** then Enter shows the same code as a
`https://getshahi.dev/pwa/#pair=…` link, for when the phone cannot see this
screen; [plugin.md](plugin.md#pairing-a-phone) has the rest, including what to
run when no herdr window is attached. The sidecar's startup log names this
command too ("pair a phone: herdr plugin action invoke shahi.pair").

From a checkout run by hand, the log says `bun run server/scripts/pair.ts`
instead. That prints "Scan with Shahi", the QR, its expiry and whether the code
was copied; `--code-only` prints only the code, as text. Either way the script
asks the running sidecar over loopback which relay it dials (`/api/meta`), so it
needs no `RELAY_URL` in the `.env` it reads.

On the phone: **Scan QR code**. The phone reads the relay off the code, checks
it is talking to the server that printed it, pairs, and lands on the agent
list. The code works once and for ten minutes; print another for another phone.

A code that arrives as a link — a tapped `shahi://pair#…`, or a
`getshahi.dev/pwa/#pair=` link opened in a browser — is never acted on
directly. The app shows **Pair this phone?** and the browser **Connect this
browser?**, each with a warning to continue only if you opened the link
yourself, the relay's host and the first 16 characters of the computer's
identity; nothing is sent until you confirm, and Cancel discards the code. A
scanned or pasted code pairs as before: scanning is already a deliberate act.

In the app the link is held above the router: `app/+native-intent.tsx` sees
every link the system hands over, on a cold launch and while running, keeps a
pairing code in `lib/incoming-pairing.ts` and routes to Connect, which shows the
card until you pair or cancel — whatever computers are saved or on screen.
Only a mounted Connect screen used to read the link, and Connect redirects away
as soon as any computer is saved, so scanning a second computer's code with the
iPhone Camera opened Shahi and did nothing, without a word (September 2026
review).

A pairing link lives for one claim, and both clients close it on its first
failure, so a code whose relay cannot be reached ends in "Try again." rather
than the "Reconnecting…" a paired device's link shows.

Settings → **Devices with access** lists every phone and browser that paired
this way, with when it was last heard from. **Revoke** throws one out; its very
next request is refused and its open connection is closed. A phone that was
offline when it was revoked is told the next time it connects through the
relay, and signs out. Revoking the phone you are holding is a sign-out and is
labelled as one.

The passcode still works, typed, over SSH. A passcode login is not a device:
it carries no identity, so it cannot be listed or revoked — the section says
so. Rotating `SESSION_SECRET` in the server's `.env` and restarting ends every
passcode session at once (the passcode itself is only checked at login, so
changing it does nothing to sessions that already exist). It does **not** sign
out relay-paired devices: each relay link proves its device's own secret, which
does not depend on `SESSION_SECRET`, and is issued a fresh session signed with
the current one.

There is no way to list or revoke devices from the computer itself —
`shahi.status` only counts them. So a lost phone that was your only paired
device is cut off from a new one: pair another phone or browser with
`shahi.pair`, then revoke the lost one under Settings → Devices with access.
Deleting the plugin's state directory also ends every pairing, along with the
server's identity and transcripts.

## What the code is

```
shahi://pair#v=1&server=<serverId>&relay=<relay base url>&secret=<token>
```

The browser link is the same code, URL-encoded, after
`https://getshahi.dev/pwa/#pair=`; both clients' parsers accept either.

- **A fragment, not a query.** If the code is ever opened as a link, a fragment
  is the one part of a URL no web server receives.
- **`server`** is the `serverId` from `identity.ts`:
  `base64url(sha256(publicKey))` of an Ed25519 keypair minted once per
  installation and kept in the database. It used to be a random UUID; the
  relay (`relay.md`) needs a box to *prove* its id, so the id became the
  hash of a key. There is no path from the UUID — a box that upgrades gets a
  new id and its phones pair again. Before handing over anything, the phone
  opens a pairing link through the relay, reads `GET /api/meta` over it, and
  refuses to claim unless the ids match — so a code aimed at the wrong relay,
  or a stranger's box behind the right one, fails before the secret is sent.
- **`relay`** is the blind relay the box is dialled into, an `https` URL (or
  `http` on loopback, for tests). It is the whole address: a code without a
  usable one is rejected as a whole.
- **`secret`** is 32 random bytes, base64url. Single use, ten minutes, kept
  only in the server process's memory (`server/lib/pairing.ts`). A restart
  voids every outstanding code; run the script again. The phone's hello names
  the code by `sha256` of those bytes, both sides key the link from the bytes,
  and the phone posts them to `/api/pair/claim` inside that sealed link.

## How the server side fits together

`pair.ts` cannot mint into another process's memory, so it asks the running
server: `POST /api/pair` (authenticated) answers a fresh code. The script
signs its own session from the `SESSION_SECRET` in `.env` — anyone who can
read that file already owns the server, so this adds no one to the trusted
set. The route is also what a future "pair another phone" button in Settings
would call.

`POST /api/pair/claim { secret, deviceName }` is unauthenticated. It has a
throttle of its own, serialized like the passcode's but separate from it, so a
flood of bad claims cannot slow the owner's login (pentest L1); at most four
claims wait at once, a fifth gets 429, and a body over 4 KiB is refused. A good
claim creates a row in the `devices` table (id, name, secret, created_at,
last_seen_at, revoked_at) and answers with the ordinary session cookie — the
same `shahi_session` the passcode login sets — except that its signed claims
carry the device id: `expiry.deviceId.signature` rather than
`expiry.signature`. The body is a `ClaimResult`: `{ ok, deviceId,
deviceSecret, device }`. The device secret is 32 bytes minted for this phone
alone, its half of the end-to-end key when it comes in through the relay; a
phone that pairs over the relay gets no cookie (a link carries its own
session) and this body is how it learns who it is.

That id is checked on **every request**. `Auth` takes a `deviceActive`
callback, `index.ts` points it at `devices.isActive`, and a revoked id makes
the token invalid regardless of its expiry. No session table, no cache to
invalidate: revocation is one `UPDATE` and the next request. The revoked
device's open WebSocket is closed at the same time rather than left streaming
the dashboard until it happens to drop.

A revoked row is kept, secret included. The secret authorizes nothing once
`revoked_at` is set; it is kept so the box can seal one `{"t":"bye"}` to that
phone when it next connects, which the relay cannot forge, and so a phone that
was offline at revocation still learns it is unpaired (`relay.md`).

`last_seen_at` moves at most once a minute — the phone polls forever, and a
write per poll would say nothing more than "recently".

## There is no address to guess

There used to be. A code carried a typed address as well as a relay, so the
script asked `tailscale status --json` for a name, fell back to the bind
address, probed whichever it picked, and warned when the probe disagreed —
several failure modes in service of a field the phone ignored whenever it had
a relay. The transport that needed it is gone, so the code carries the relay
and nothing else, and a box without one refuses to mint rather than printing
something unusable.

## Not done

- **Scanning with a physical iPhone's camera is unverified.** Expo's barcode
  scanner does not work on the simulator, so the simulator runs pair by link;
  the September 2026 reports (`customer-journeys-2026-09-18.md`) still list a
  real camera scan as outside what was run. `docs/verify-on-device.md` is where
  that belongs.
- **Minting from the phone.** `POST /api/pair` exists and is authenticated,
  so a paired phone could show a code for the next phone. Not built: no one
  has asked for it yet.
- **Revoking from the computer.** See above: a lost sole device needs a second
  one to revoke it.
