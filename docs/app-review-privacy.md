# Privacy and beta review readiness

Source disclosures checked: 4 October 2026. The App Store Connect observations
below are dated; they do not establish the current status of its private fields.

Shahi 1.0.0 is publicly listed on the
[App Store](https://apps.apple.com/app/id6813370698). The repository now targets
1.1.0; source features and a passing simulator build do not establish which
features are present in the public 1.0.0 binary. Check the actual distributed
build when completing its privacy and review answers.

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
itself has no revocation command.

With a relay-paired phone and a computer offering `push-actions`, the phone gives
the computer a random notification key over the encrypted relay. The computer
seals the question, context, exact answer labels, conversation/workspace names
and pane occupant identity; the phone's notification extension decrypts them.
Expo and Apple receive fixed wording, pane and public computer identifiers, a
key identifier and encrypted content. SSH/passcode connections and older builds
retain the plain notification payload: workspace name, terminal title or pane
name, pane identifier, pane occupant identity and public computer identifier.
See [the policy](privacy-policy.md#push-notifications) and
[notification behavior](notifications.md). Confirm this distinction against the
submitted binary; the extension requires a new native build.

## Apple data categories

The app manifest and App Store Connect disclose these categories, with no
tracking. They are conservatively marked linked because identifiers are not
guaranteed to be irreversibly anonymized before collection.

| Category | Purpose | Basis |
| --- | --- | --- |
| Device ID | App functionality, analytics | Push registrations and stable relay computer identifiers |
| Product interaction | App functionality, analytics | Connection events, counts and session activity |
| Crash data | App functionality | Sentry crash reports and Expo Updates launch/crash diagnostics |
| Performance data | App functionality | Connection timing and traffic measurements |
| Other diagnostic data | App functionality | Sentry Reader failure categories, retries and versions; operational failures and close codes |

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

On 20 September 2026, external beta review had not been submitted and the saved
pending-access notes still needed replacement with these instructions. That
observation does not establish today's review state. Recheck the actual private
review instructions for each submission.

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
   any obsolete pending-access notes with the verified steps.
5. If using a demonstration mode instead of working account access, resolve
   Apple's approval requirement for that substitution before relying on it.
6. Complete external beta review and verify approval before sharing a public
   TestFlight link. Internal TestFlight availability is not external approval.

Keep reviewer secrets out of Git and public documentation. France remains
excluded pending the separate export-compliance process.

On 20 September 2026, App Information showed age ratings and content rights as
not configured, and Digital Services Act account information had a Set Up link.
These are historical observations, not current blockers inferred from this
file. Verify the current settings for the selected release and distribution
regions.

For a public App Store release, also finish and verify screenshots, age rating,
content rights, store description, support URL, pricing/availability, the selected
release build and final review instructions. Beta metadata alone does not
complete the public App Store submission.
