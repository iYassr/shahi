# iOS release checklist

Use this checklist for each TestFlight or App Store build. Source tests and a
simulator build do not establish that a physical-device release is ready.

## Encryption and export compliance

`mobile/app.json` intentionally omits `ITSAppUsesNonExemptEncryption` and
`ITSEncryptionExportComplianceCode`, so Apple asks the build-specific questions.
The app bundles OpenSSL/libssh2 for SSH and implements encrypted relay sessions.
Do not insert an empty export code or assert that the app has no encryption.
Complete the questions for the actual build and distribution regions in
[App Store Connect](https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance).
Determine whether documentation or reporting is required before release; do not
infer an exemption solely from use of standard algorithms.

## Privacy disclosures

Review [the privacy policy](privacy-policy.md) against the release build and
complete Apple's [App Privacy details](https://developer.apple.com/app-store/app-privacy-details/).
Include third-party processing and assess each data category and purpose:

- Cloudflare relay connection metadata and operational telemetry.
- Expo/platform push tokens and notification payloads, when enabled.
- Credentials and preferences stored locally on the device.
- Website beta-signup emails retained in the support inbox. Distinguish website
  collection from data collected by the app when answering Apple's questions.

Do not use a blanket “no data collected” answer without this review. Link the
published policy in App Store Connect and the app. Keep `docs/privacy-policy.md`
and `site/public/privacy.html` aligned; they are maintained separately.
Verify the support and privacy contact addresses before submission.

## Device verification

- Pair through the default QR/relay flow; test expired codes and revoked devices.
- Test SSH authentication, host-key changes, disconnects, and recovery.
- Confirm the generated app's ATS settings match the intended loopback-only
  exception and test SSH networking on a physical device.
- Verify push delivery and notification taps on a physical device.
- Check VoiceOver, larger text, Reduced Motion, permission denial, and keyboard
  behavior. See [device checks](verify-on-device.md).
- Test upgrades from the previous distributed build, including session recovery.

## Submission

Confirm Apple Developer membership, bundle ID `app.shahi.mobile`, signing, build
number, screenshots, support URL, and current store metadata. Explain that Shahi
requires herdr on a computer the user controls. Use sample sessions for public
screenshots; never publish pairing codes or real private conversations.

Build with the production profile and submit through the documented EAS or
Xcode workflow. Complete TestFlight review requirements before inviting external
testers. The website signup form records requests; it does not issue invitations.

### EAS submission for this project

Run from `mobile/`. The production submit profile targets App Store Connect app
`6813370698` (`app.shahi.mobile`). Signing credentials and the App Store Connect
upload key are managed by EAS; do not commit certificates or private keys.

```sh
bunx eas-cli build --platform ios --profile production --non-interactive --auto-submit
```

If signing needs renewal, run `bunx eas-cli credentials --platform ios` locally
and authenticate directly in the terminal. If a build already exists but its
submission failed, submit that build ID rather than creating another build:

```sh
bunx eas-cli submit --platform ios --profile production --id BUILD_ID --non-interactive
bunx eas-cli submit:status --platform ios --json --non-interactive
```

A scheduled submission is not a completed upload. Check EAS submission status,
then Apple's processing/TestFlight status. Export-compliance or beta-review
requirements may still prevent tester access after a successful upload.

If the cloud build allowance is exhausted, a Mac with Xcode, CocoaPods and
Fastlane can build with the same EAS-managed signing credentials. Run from
`mobile/`, keeping the signed archive outside the repository:

```sh
npx --yes eas-cli@latest build --platform ios --profile production --non-interactive --local --output /tmp/shahi-release.ipa
npx --yes eas-cli@latest submit --platform ios --profile production --non-interactive --path /tmp/shahi-release.ipa
```

Inspect the IPA's version, privacy manifest and encryption keys before the
submit step. The local signing certificate also needs Apple's current WWDR
intermediate certificate in the Mac's keychain; download it only from Apple's
certificate authority. EAS removes its temporary signing keychain afterward.

### Verified status on 18 September 2026

Production iOS build `1.0.0 (6)` completed in EAS, but Apple rejected submission
`b6780b6c-62a1-4c93-8586-9c1941b05f27` with “Invalid Export Compliance Code”.
Signing credentials are configured; this is an encryption declaration blocker.
Chrome inspection confirmed that TestFlight has no builds and App Information
has no encryption documentation attached. The owner confirmed distribution in France. With standard encryption and France
selected, Apple requires a “French encryption declaration approval form”
attachment and disables Save until it is supplied. The declaration is still
unsaved; no approval document has been supplied. Do not flip
`ITSAppUsesNonExemptEncryption` merely to bypass this validation.

The France export-compliance process remains unresolved. Keep France excluded
until the required documentation is accepted. Private declarations, signed
forms, attachments and regulatory correspondence are stored outside this
repository; do not include their contents in public release documentation.

#### Remaining steps for TestFlight

On 19 September, the owner decided to exclude France for now. Apple's
[documentation requirements](https://developer.apple.com/help/app-store-connect/reference/app-information/export-compliance-documentation-for-encryption)
require the French declaration for standard encryption only when distributing
on the App Store in France. App Store Connect now lists France as **Not
Available**, with the other 174 countries or regions available on app release.
Automatic availability in future countries was disabled.

The encryption questionnaire was completed with standard algorithms implemented
outside Apple's operating system and no distribution in France. Apple displayed
that no documents were required, and the result was acknowledged. No export code
was issued and the existing build's encryption metadata was not changed.

Retry submission `97b7a897-a9f1-4623-8a4a-4fbc4c738289` for the existing build
`1.0.0 (6)` finished successfully in EAS at 14:17 UTC on 19 September, but Apple
rejected the delivered binary by email at 17:18 Riyadh time with **ITMS-90592:
Invalid Export Compliance Code** (empty key value). The email explicitly asks
for a corrected new binary. EAS success records delivery, not Apple's acceptance;
the empty TestFlight list must not be described as confirmed processing.

1. Keep France excluded from App Store availability. Check TestFlight
   distribution separately and keep French testers out of this initial beta.
   Keep the app's encryption answers accurate; excluding a country does not
   change which cryptography the app uses.
2. Build 7 removes the predeclared non-exempt flag without substituting an
   exemption assertion or invented code. Apple's documented behavior for an
   omitted flag is to ask the export-compliance questions for each uploaded
   build. Verify both keys are absent from the actual IPA before submitting.
3. Complete any build-specific encryption questions for the same distribution
   scope once Apple accepts the replacement binary.
4. Verify successful upload, Apple processing, and TestFlight availability.
   Complete any external beta review before inviting external testers.

Before adding France later, resolve ANSSI's instructions, consolidate the
dossier, and obtain the required documentation. Have the owner review and sign
the final version; do not transfer the earlier signature to revised content.

### Replacement build 7

EAS build `eac2c4a9-8f60-4572-924f-36549c2f9a29` completed on 19 September.
The downloaded signed IPA was inspected: bundle `app.shahi.mobile`, version
`1.0.0`, build `7`, and both encryption declaration keys absent as intended.
The mobile suite passed (40 suites, 324 tests), and the repository type checks
passed.

Submission `8de95303-e9b4-46d8-8ff3-8c510b2645de` completed, and Apple accepted
the binary with processing state `VALID`. The build-specific questionnaire was
saved with standard algorithms outside Apple's operating system and no French
distribution. Apple then reported `IN_BETA_TESTING` for internal testing and
`READY_FOR_BETA_SUBMISSION` for external testing. Chrome confirmed build
`1.0.0 (7)` has status **Testing** in the existing **Team (Expo)** internal group,
with the account owner invited. External beta review has not been submitted;
there is no public beta link. France remains excluded.

The working App Information route is
`https://appstoreconnect.apple.com/apps/6813370698/distribution/info`.
The bare app-ID URL can display only the navigation shell; use Distribution →
App Information or the TestFlight tab after signing in.

### Privacy readiness and build 8

On 19 September, the public privacy policy was expanded to cover permissions,
Expo updates and diagnostics, support, notifications, retention, and deletion.
The website deployment is `7ff719ee-df87-48d3-a240-56575f660afa`. App Store
Connect's privacy label and policy/choices URLs are published. TestFlight's
description and review contact details are saved. See
[the privacy and reviewer-access checklist](app-review-privacy.md) for the data
category rationale and remaining external-review requirements.

Build `a4105532-650d-4359-b47b-5187454ba568`, version `1.0.0 (8)`, adds privacy
and support links to iPhone onboarding and Settings, and a matching privacy
manifest. The signed IPA was inspected: all five declared collection categories,
no tracking, the three required-reason API declarations retained, and both
encryption declaration keys absent. Mobile validation passed (324 tests and
type checks); hosted-web validation passed (48 tests); PWA validation passed
(11 tests, one skipped). Reviewer access is not yet provisioned; external beta
review remains unsubmitted.

Submission `2053f848-aa85-4489-83e9-e95c34df9bef` delivered build 8. Apple
accepted it as `VALID`; after the standard-algorithm/no-France questionnaire,
Apple reports `IN_BETA_TESTING` internally and `READY_FOR_BETA_SUBMISSION`
externally. The privacy update is available to internal TestFlight testers.

### Isolated reviewer computer — 20 September 2026

The private review environment is deployed at https://review.getshahi.dev using
Cloudflare Workers, Containers and a private recovery bucket. Model replies are
clearly simulated; pairing, the encrypted relay and file tools use the real
server. See [review readiness](app-review-privacy.md) and [operations](../demo/README.md).
Review credentials are stored privately outside this repository. App Store
Connect's access fields still need updating; external review remains unsubmitted.

### Local release build 12 — 20 September 2026

Version `1.0.0 (12)` was built locally with Xcode 27 after the EAS cloud build
allowance was exhausted. The signed IPA contains the Spaces folder icon and
the current mobile feedback fixes, including the native PDF module. All 326
mobile tests and repository type checks passed. The IPA's privacy manifest
was verified, with tracking disabled and both encryption declaration keys absent.

EAS submission `d699f10c-50d1-4c6f-819a-3ab008863154` successfully delivered
the IPA. App Store Connect completed processing and the standard-algorithm,
no-France export questionnaire was saved. Apple's status API confirms `VALID`
and `IN_BETA_TESTING`, with access through the existing Team (Expo) internal
group. External status is `READY_FOR_BETA_SUBMISSION`; external beta review
remains unsubmitted.

### Resumable uploads — build 13, 20 September 2026

Version `1.0.0 (13)` was built locally with the iOS 27 SDK. It adds progress,
cancellation and bounded, resumable 32 MiB relay uploads with an updated computer
service, plus the numbered Spaces folder badge. The signed IPA includes the
privacy manifest and omits both encryption declaration keys, as build 12 did.

EAS submission `dd505443-0afe-4838-977a-392062c702ba` delivered the binary.
Apple reports `VALID` and `IN_BETA_TESTING`; Chrome confirms access through
Team (Expo). External status remains `READY_FOR_BETA_SUBMISSION`, so this is
an internal TestFlight release. France remains excluded.

The Apple upload API key was rotated and the replacement assigned to EAS.
TestFlight access was verified after revoking the previous key. Private keys
remain outside the repository; never serialize Apple SDK models or credential
contexts in diagnostic output.
