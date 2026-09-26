# Shahi — Privacy Policy

_Last updated: 26 September 2026. Published at
<https://getshahi.dev/privacy>._

## What Shahi does

Shahi connects to a server **you** run to read and control your terminal
sessions. The native app and hosted web app use an encrypted relay connection. The
native app also supports SSH. A locally served web app connects directly to
the sidecar, which answers only requests addressed to `127.0.0.1` or
`localhost`; reach it from another device through an SSH tunnel, or through an
HTTPS proxy whose name you list in `SHAHI_ALLOWED_HOSTS`.

## What is stored on your device

The native app stores its connection credentials in the iOS Keychain: your
relay address, server identifier and paired-device secret, or your SSH host,
username, password or private key, passphrase, sidecar passcode and the SSH
host keys you chose to trust. With notifications on, it also keeps the push
token it registered with each computer, so it can say whether they are on and
turn them off. It also stores local preferences such as pinned
conversations and terminal width. These Keychain items are kept on this device
only: they are not restored to another device from a backup, so a restored
iPhone must be paired or connected again.

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

The browser app trusts the code delivered by `getshahi.dev`, including its
hosting and publishing accounts. A malicious release or compromised website
could read an active session or a remembered pairing secret. End-to-end
encryption protects traffic from the relay, but does not protect against
compromised application code. The website ships no third-party scripts and
restricts executable content with a Content Security Policy.

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
connection or refusal details, a count or close code, aggregated bytes and frame
counts in each direction, connection and handshake durations, and, when available, the
Cloudflare data-center region. These events can be correlated for the same
server. Shahi's telemetry does not record raw IP addresses, request paths,
message bodies or file contents.

Analytics Engine retains these events for **three months**, according to
[Cloudflare's retention documentation](https://developers.cloudflare.com/analytics/analytics-engine/limits/).
Cloudflare also processes network and security metadata as the infrastructure
provider under its own policies. Removing the `TELEMETRY` binding disables
Shahi's event collection for a self-hosted relay. Setting no stats API token
only hides the stats endpoint; it does not disable event collection.

The website records signup response status and duration in Analytics Engine,
kept for three months, without the submitted email address or form content. It
also logs failed deliveries and a sample of other outcomes to Cloudflare Workers
Logs, kept for seven days, recording only the status and duration.

The relay also writes these structured operational fields to Cloudflare Workers
Logs, retained for **seven days** on the paid plan. Automatic invocation logs
and tracing are disabled in Shahi's configuration; they can include raw URLs.
The operational monitor records public-service probe results, durations and
incident state, and sends incident/recovery email to the operator's configured
address. Its latest incident state persists until replaced or deleted. Probe
identities are synthetic and never refer to a user's computer.

On your computer, the sidecar keeps private operational JSON logs: route
**templates** (without IDs or query values), method, status, timings, counts,
resource usage and fixed error categories. These stay on your computer and
rotate across four files of up to 5 MiB each. Terminal text, prompts, file
contents, credentials, filenames and raw error messages are excluded. Request
metrics reset when the sidecar restarts. The diagnostic API requires a valid
Shahi session. Local alerts stay in these logs; the public service monitor does
not collect individual computers' local diagnostics.

The native and web clients contain no advertising or third-party tracking
SDKs. Relay operational telemetry is separate from client analytics.

## Push notifications

Notifications are **off unless you enable them**. Your server stores the push
registration and associates it with the device or signed-in session that
registered it. Revoking a paired device or signing out through the server
removes the corresponding registrations, and a registration made with a
passcode sign-in is removed when that sign-in expires. Turning notifications off in the web
app removes that browser's registration for the current computer. Disabling
notifications in iOS Settings stops display but does not itself delete the
server registration.

Native notifications travel through **Expo's push service** and then the
platform push provider, such as Apple's Push Notification service. Their
payloads include the workspace name, the terminal title or pane name, the pane
identifier to open, and your computer's public server identifier, the same
stable identifier the relay sees. Expo and the platform provider can read that
content even though relay traffic is encrypted end to end. Browser
notifications carry the same fields through the browser's push service,
encrypted so that only your browser can read them; that service also sees a
short hash of the computer and pane, used to replace an undelivered
notification for the same pane. Notifications ask push providers to discard
them if they cannot be delivered within an hour. Leave notifications off if you
do not want that content sent through push providers.

Your server stores original agent transcripts and uploaded files under your
control. The relay does not store those contents.

## Who runs Shahi

Shahi is provided by Yasser Aldosari, an independent developer in Saudi Arabia. You do not need a Shahi account: you connect to a computer you control. For privacy questions or requests, contact support@getshahi.dev.

## Camera, photos and files

Camera access is used to scan pairing codes. Scanning happens on your device. Photos and files are accessed when you choose an attachment; only the items you select are sent to your connected computer. These permissions are optional and can be changed in your device settings. Shahi does not request microphone, contacts or location access.

## App updates and service providers

The iPhone app checks Expo for signed app updates when it opens. Expo receives network information and update-request metadata, such as the app version, platform and runtime version, and update-related crash or launch diagnostics. Updates do not send your conversations or SSH credentials to Expo. Cloudflare hosts the website and relay. The website serves its own fonts, so no font provider receives your visit. These providers may process data outside your country under their own privacy policies. The AI assistants you run on your computer use their own providers; their handling of prompts and files is separate from Shahi.

## TestFlight and support

When you use TestFlight, Apple processes beta-testing information, including installation and usage information, crash reports and feedback you choose to send. Apple makes some of this information available to the developer. If you contact support, we receive your email address and the information or attachments you send. Avoid including passwords, pairing codes or private conversations. We use support messages to respond to your request and maintain the service, and retain them until deleted or no longer needed.

## Your choices and deletion

To remove a saved computer from the iPhone app, use Computers or sign out of that computer in Settings. This removes its saved connection from the app. Sign out while connected so the server can revoke access and push registrations; if the computer is offline, revoke the device later under Settings → Devices with access on another phone or browser paired with that computer. Other saved computers remain until removed. iOS Keychain items may survive uninstalling the app, so remove saved connections first. Deleting a connection does not delete transcripts or uploaded files on your computer; delete those on that computer. Turn notifications off in the app's Settings to stop a computer sending them, or in iOS Settings to stop their display. There is no Shahi account to delete. Email support@getshahi.dev to request access, correction or deletion of beta-signup and support information. We may need to verify the request. Operational records expire under the retention periods above; legal obligations may require some records to be retained.

## How we use data

We use connection information to provide the service, protect it from abuse and diagnose failures. We use optional notification registrations to deliver notifications, and email information to respond to support and beta requests. We do not sell personal data, serve ads or track people across other companies’ apps and websites. Where applicable, you may have rights to access, correct, delete or restrict use of your personal information and complain to your local data protection authority. Contact us to exercise those rights.

## Changes to this policy

We update this page when our practices change and show the date above. Material changes that require a new choice or permission will be presented through the relevant service or app permission prompt.

## Private review environment

Apple reviewers may receive access to a separate demonstration computer hosted
on Cloudflare. Its agent replies are clearly labeled simulations and do not go
to an AI provider. Unlike a user's own computer, this demo is operated by us: its
sample conversations, selected uploads, files, and pairing records are stored in
the container and private recovery snapshots. Use sample information only. The
review website uses an essential, seven-day sign-in cookie, with no advertising
or cross-site tracking. Demo access expires on 31 December 2026; the next scheduled
cleanup stops the computer and deletes the recovery snapshot. Contact
support@getshahi.dev to request earlier removal of review data.

## Children

Shahi is a developer tool and is not directed at children.

## Contact

Questions about this policy: **support@getshahi.dev**.

## iOS beta requests

If you request an iOS beta invitation, we send your email address to the Shahi support inbox using Cloudflare Email Routing. We use it to contact you about TestFlight access and beta updates. The website does not keep a separate signup database. Your request remains in the support mailbox until deleted. Email support@getshahi.dev to withdraw your request or ask us to delete it.
