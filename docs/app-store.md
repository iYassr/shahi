# iOS release checklist

Use this checklist for each TestFlight or App Store build. Source tests and a
simulator build do not establish that a physical-device release is ready.

## Encryption and export compliance

`mobile/app.json` currently sets `ITSAppUsesNonExemptEncryption` to `true`.
The app bundles OpenSSL/libssh2 for SSH and implements encrypted relay sessions.
This setting is not a legal classification or confirmation of an exemption.
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
