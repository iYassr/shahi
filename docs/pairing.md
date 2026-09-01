# Pairing a phone by scanning a code

How a phone is introduced to a Shahi server without typing an address or a
passcode, and what that buys beyond convenience: a session that belongs to a
*device*, which can be seen and revoked. This is step 2 of the build order in
`connectivity.md`, done over the transports that exist today — Tailscale and
SSH. The E2E relay transport is not part of it and nothing here assumes it.

## Using it

On the server, with Shahi running:

```sh
bun run server/scripts/pair.ts                       # guesses the address the phone uses
bun run server/scripts/pair.ts --endpoint https://box.tailnet.ts.net
```

It prints a QR and the same text under it. On the phone: Connect → **Scan a
code**. The phone reads the address off the code, checks it is talking to the
server that printed it, pairs, and lands on the agent list. The code works once
and for ten minutes; print another for another phone.

Settings → **Paired devices** lists every phone that paired this way, with when
it paired and when it was last heard from. **Revoke** throws one out; its very
next request is refused. Revoking the phone you are holding is a sign-out and
is labelled as one.

The passcode still works, typed, over Tailscale or SSH. A passcode login is
not a device: it carries no identity, so it cannot be listed or revoked — the
section says so. To end them all at once, rotate `SESSION_SECRET` in the server's `.env` and restart — the passcode itself is only checked at login, so changing it does nothing to sessions that already exist. (That rotation signs every paired phone out too.)

## What the code is

```
shahi://pair#v=1&server=<serverId>&endpoint=<base url>&secret=<token>
```

- **A fragment, not a query.** If the code is ever opened as a link, a fragment
  is the one part of a URL no web server receives.
- **`server`** is the `serverId` from `identity.ts`, minted once per
  installation. The phone fetches `GET /api/meta` at `endpoint` and refuses to
  claim unless the ids match — so a code aimed at the wrong address, or a
  stranger's server at the right one, fails before the secret is sent there.
- **`secret`** is 32 random bytes, base64url. Single use, ten minutes, kept
  only in the server process's memory (`server/lib/pairing.ts`). A restart
  voids every outstanding code; run the script again.

## How the server side fits together

`pair.ts` cannot mint into another process's memory, so it asks the running
server: `POST /api/pair` (authenticated) answers a fresh code. The script
signs its own session from the `SESSION_SECRET` in `.env` — anyone who can
read that file already owns the server, so this adds no one to the trusted
set. The route is also what a future "pair another phone" button in Settings
would call.

`POST /api/pair/claim { secret, deviceName }` is unauthenticated and goes
through the same `LoginThrottle` as the passcode. A good claim creates a row
in the `devices` table (id, name, created_at, last_seen_at, revoked_at) and
answers with the ordinary session cookie — the same `shahi_session` the
passcode login sets — except that its signed claims carry the device id:
`expiry.deviceId.signature` rather than `expiry.signature`.

That id is checked on **every request**. `Auth` takes a `deviceActive`
callback, `index.ts` points it at `devices.isActive`, and a revoked id makes
the token invalid regardless of its expiry. No session table, no cache to
invalidate: revocation is one `UPDATE` and the next request. The revoked
device's open WebSocket is closed at the same time rather than left streaming
the dashboard until it happens to drop.

`last_seen_at` moves at most once a minute — the phone polls forever, and a
write per poll would say nothing more than "recently".

## The address the script guesses

`--endpoint` is the address the *phone* will use, which the box cannot know
for certain. Without it the script does what `install.sh` does: the Tailscale
name (behind `tailscale serve`, so `https://`) if there is one, the bind
address if it is not loopback, and otherwise it stops and asks. Whatever it
picks is probed from the box before printing, and a mismatch or no answer is
printed as a warning under the code — so a wrong guess is reported here and
not as a mysterious refusal on the phone.

## Not done

- **`install.sh` does not print a code.** It prints the address and the
  passcode as before; pairing is the script. Folding the script's output into
  the installer's last screen is the obvious next step and was left out of
  this change deliberately — the installer is shared ground.
- **Not verified on a device.** The camera is a native module: `npx expo
  prebuild --platform ios` must run before the next native build
  (`docs/on-a-mac.md` explains why `run:ios` alone does not re-read
  `app.json`), and Expo's docs say barcode scanning does not work on the
  simulator at all. The scanner has been read against the SDK 57 docs and
  typechecks; the first real scan is the proof. `docs/verify-on-device.md` is
  where that belongs.
- **Minting from the phone.** `POST /api/pair` exists and is authenticated,
  so a paired phone could show a code for the next phone. Not built: no one
  has asked for it yet.
