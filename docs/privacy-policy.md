# Shahi — Privacy Policy (draft)

**Draft for review. Have it checked before publishing, and host it at a stable
URL — the App Store submission requires a privacy-policy link, and the App
Privacy "nutrition label" answers must match what this says.**

_Last updated: fill in on publish._

## The short version

Shahi is a client for a server **you** run. It does not have a backend of ours.
Your credentials and your terminal data flow between your phone and your own
machine; they are not sent to us, because there is no "us" in the path.

## What the app stores, and where

All of the following is stored **only on your device**, in the iOS Keychain, and
is never transmitted to the developer:

- The address of your server (or its SSH host, port, and username).
- Your sidecar passcode.
- For SSH connections: your password or private key and its passphrase.
- Local preferences (pinned conversations, terminal width).

The app holds a session cookie for your server, again only on your device.

## What the app transmits, and to whom

- **To your server only:** requests to read and control your terminal sessions,
  and the credentials above to authenticate. Over Tailscale this goes across
  your tailnet; over SSH it is carried inside the encrypted SSH tunnel. Nothing
  is proxied through any server of ours.
- **Terminal content** (what your agents and shells display) is fetched from
  your server to show it to you, and is not stored by us or sent anywhere else.

## Analytics and tracking

The app contains **no analytics, no advertising, and no third-party tracking
SDKs.** No usage data is collected.

## Push notifications

Notifications are **off unless you turn them on.** If you enable them, the app
obtains a push token and stores it on **your** server, which uses it to alert
you when an agent needs input.

Be aware of the delivery path, because it is the one place data leaves the
loop between your phone and your own machine: the token is an **Expo** push
token, and a notification your server sends is relayed through **Expo's push
service** and then Apple's Push Notification service before it reaches your
phone. The message carries the notification's title and body (for example, the
agent's name and that it is waiting) and the id of the pane to open. Expo and
Apple are third parties in this path; everything else in the app talks only to
your server. If you would rather nothing transit a third party, leave
notifications off — the app is fully usable without them.

## Children

Shahi is a developer tool and is not directed at children.

## Contact

Add a contact email/URL before publishing.
