# Shahi — Privacy Policy

_Last updated: 5 September 2026. Published at
<https://getshahi.dev/privacy>._

## What Shahi does

Shahi connects to a server **you** run to read and control your terminal
sessions. The native app and hosted web app use an encrypted relay connection. The
native app also supports SSH. A locally served web app connects directly to
the sidecar; use HTTPS or an SSH tunnel when accessing it across a network.

## What is stored on your device

The native app stores its connection credentials in the iOS Keychain: your
relay address, server identifier and paired-device secret, or your SSH host,
username, password or private key, passphrase and sidecar passcode. It also
stores local preferences such as pinned conversations and terminal width.

The hosted web app keeps its paired-device secret in memory by default. If
you select “Remember this browser”, it stores that secret and the relay, server
and device identifiers in IndexedDB in your browser profile. Anyone using that
profile can access the paired computer. Signing out clears the saved pairing
and requests revocation on your server. Browser extensions or compromised code
on the application origin may access an active or remembered connection.

The locally served web app uses a session cookie to authenticate. Both web
builds store preferences in browser storage. The service worker caches public
app assets for offline launching, but does not cache API responses or transcripts.
Conversation content is held in memory while the app is running. Signing out
does not delete original transcripts on your server.

## What is transmitted

**To your server:** requests to read and control sessions, messages and files
you choose to send, and credentials needed to authenticate. Relay
frames are encrypted end to end between your device and server. SSH connections
are carried inside an encrypted SSH tunnel.

**Through the relay:** by default, the native app, hosted web app and your server connect to
`relay.getshahi.dev`, a Cloudflare Worker operated by the developer. The relay
and Cloudflare can observe IP addresses, the public server identifier,
paired-device identifier in the handshake, connection times, and the size and
timing of encrypted messages. They cannot decrypt request paths, messages,
files, terminal content or credentials inside those frames.

To avoid this relay, set `RELAY_URL=` (empty) in the plugin configuration and
use SSH. A self-hosted relay is controlled by its operator.

## Browser camera and pairing links

The browser requests camera permission only after you choose to scan a QR code.
Video frames are decoded locally and are not uploaded. Scanning stops when you
cancel, leave the page or finish scanning. Pasted and scanned pairing codes are
used to claim one device and are not retained as saved credentials. Browser
pairing links carry the one-time secret in the URL fragment; it is removed when
the app reads it and is not sent to the website in an HTTP request.

## Operational telemetry and retention

The hosted relay records connection and failure events in **Cloudflare
Workers Analytics Engine** to diagnose availability and abuse. Each event
contains a timestamp, public server identifier (a stable key hash), event type,
connection or refusal details, a count or close code, and, when available, the
Cloudflare data-center region. These events can be correlated for the same
server. Shahi's telemetry does not record raw IP addresses, request paths,
message bodies or file contents.

Analytics Engine retains these events for **three months**, according to
[Cloudflare's retention documentation](https://developers.cloudflare.com/analytics/analytics-engine/limits/).
Cloudflare also processes network and security metadata as the infrastructure
provider under its own policies. Removing the `TELEMETRY` binding disables
Shahi's event collection for a self-hosted relay. Setting no stats API token
only hides the stats endpoint; it does not disable event collection.

The native and web clients contain no advertising or third-party tracking
SDKs. Relay operational telemetry is separate from client analytics.

## Push notifications

Notifications are **off unless you enable them**. Your server stores the push
registration and associates it with the device or signed-in session that
registered it. Revoking a paired device, signing out through the server, or
disabling notifications removes the corresponding registrations.

Native notifications travel through **Expo's push service** and then the
platform push provider, such as Apple's Push Notification service. Browser
notifications travel through the browser's push provider. Notification payloads
include workspace names, terminal titles, and the pane identifier to open.
These providers therefore receive notification content even though
relay traffic is encrypted end to end. Leave notifications off if you do not
want that content sent through push providers.

Your server stores original agent transcripts and uploaded files under your
control. The relay does not store those contents.

## Children

Shahi is a developer tool and is not directed at children.

## Contact

Questions about this policy: **privacy@getshahi.dev**.

## iOS beta requests

If you request an iOS beta invitation, we send your email address to the Shahi support inbox using Cloudflare Email Routing. We use it to contact you about TestFlight access and beta updates. The website does not keep a separate signup database. Your request remains in the support mailbox until deleted. Email privacy@getshahi.dev to withdraw your request or ask us to delete it.
