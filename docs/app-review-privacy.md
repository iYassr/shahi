# Privacy and beta review readiness

Last checked: 20 September 2026.

## Published disclosures

- Public policy: https://getshahi.dev/privacy
- Privacy choices: https://getshahi.dev/privacy#your-choices
- Support and privacy requests: support@getshahi.dev
- The iPhone connection screen and Settings include privacy and support links.
- App Store Connect's App Privacy responses and both policy URLs are published.
- TestFlight's beta description, feedback address, marketing URL, policy URL,
  review contact and explanatory notes are saved.
- The store category is Developer Tools; the subtitle is "Your coding agents,
  on the go".

The policy covers relay metadata and retention, encrypted content, local saved
connections, optional notifications, camera and attachment permissions, Expo
updates, TestFlight feedback, website providers, support, and deletion choices.
Removing a computer does not delete files or conversations on that computer.
Disabling notifications in iOS stops display; it does not delete a server's push
registration. Removing a computer while it is offline leaves its device record
active until it is revoked from another paired phone or browser; the computer
itself has no revocation command. Native notification payloads, which Expo and
Apple can read, include the workspace name, terminal title or pane name, pane identifier and
the computer's stable public server identifier (policy updated 23 September
2026).

## Apple data categories

The app manifest and App Store Connect disclose these categories, with no
tracking. They are conservatively marked linked because identifiers are not
guaranteed to be irreversibly anonymized before collection.

| Category | Purpose | Basis |
| --- | --- | --- |
| Device ID | App functionality, analytics | Push registrations and stable relay computer identifiers |
| Product interaction | App functionality, analytics | Connection events, counts and session activity |
| Crash data | App functionality | Expo Updates launch/crash diagnostics |
| Performance data | App functionality | Connection timing and traffic measurements |
| Other diagnostic data | App functionality | Operational failures and close codes |

User-controlled computers store conversations and uploads; the relay cannot
decrypt them. Do not describe this as zero data collection: service providers
process network and operational information. Voluntary, infrequent support
messages are covered in the policy and use Apple's optional-disclosure criteria;
website beta signups are separate from in-app collection. Reassess these choices
if support collection, telemetry, providers or retention change.

References: [Apple's disclosure definitions](https://developer.apple.com/app-store/app-privacy-details/),
[Expo's App Store guidance](https://docs.expo.dev/distribution/app-stores/),
[Expo push retention](https://docs.expo.dev/push-notifications/faq/).

## Private reviewer environment

An isolated Cloudflare Container is deployed at https://review.getshahi.dev.
The private review password produces fresh one-use pairing codes. Credentials
remain outside Git and must be entered in App Store Connect's private fields.
The real Shahi server, herdr, relay encryption, file transfers and Codex client
run in this environment. Model responses are explicitly simulated locally;
there are no AI provider credentials or charges. Use only synthetic sample data.
The controller checkpoints pairing, sample files, attachments and transcripts
to private R2 storage. Access expires 31 December 2026; scheduled cleanup stops
the container and deletes its snapshot. See [demo operations](../demo/README.md).

External beta review has not been submitted. App Store Connect's previously
saved pending-access notes still need replacement with these instructions.
Apple has not approved simulated responses as a review substitute.

Before submitting external review:

1. Keep the isolated demo available for the review period and extend its expiry
   if Apple needs longer. Keep personal data out of it.
2. Supply durable, reproducible connection instructions. A short-lived or
   single-use QR code alone is not sufficient for an asynchronous review.
3. Test access from a fresh installation over a separate network: connect,
   create an agent, send a message/file, read tool activity, reconnect and remove
   the connection. Confirm the environment stays online throughout review.
4. Enter the real connection credentials in App Store Connect's private review
   fields, enable its sign-in requirement as appropriate, and replace the
   current explicit "not yet ready" notes with the verified steps.
5. If using a demonstration mode instead of working account access, resolve
   Apple's approval requirement for that substitution before relying on it.
6. Complete external beta review and verify approval before sharing a public
   TestFlight link. Internal TestFlight availability is not external approval.

Keep reviewer secrets out of Git and public documentation. France remains
excluded pending the separate export-compliance process.

App Information still shows age ratings and content rights as not configured;
Digital Services Act account information also has a Set Up link. Resolve these
before public release rather than treating the privacy label as full approval.

For a public App Store release, also finish and verify screenshots, age rating,
content rights, store description, support URL, pricing/availability, the selected
release build and final review instructions. Beta metadata alone does not
complete the public App Store submission.
