# Shipping to the App Store — checklist

What has to be true before an App Store submission, beyond a green build. Items
marked **(you)** need a human — an account, a legal call, or a device.

## Export compliance
- `ITSAppUsesNonExemptEncryption` is now **true** (`mobile/app.json`), because
  the SSH module bundles OpenSSL and does general-purpose encryption. Declaring
  `false` would be inaccurate.
- **(you)** At submission, App Store Connect will ask export-compliance
  questions. Shahi uses only **standard/mass-market cryptography** (SSH, TLS),
  which qualifies for the exemption under ECCN 5D992 — answer accordingly. If
  your legal position needs it, file the annual self-classification report with
  the US BIS. When in doubt, confirm with counsel.

## Privacy
- **(you)** Publish `docs/privacy-policy.md` at a stable URL and link it in App
  Store Connect. Have it reviewed first.
- **(you)** Fill in App Privacy "nutrition labels" to match: no data collected,
  no tracking — except the push token (Apple category "Identifiers", used for
  app functionality, not tracking) once notifications ship.

## Accounts & assets **(you)**
- Apple Developer Program membership, app record, bundle id `app.shahi.mobile`.
- Screenshots for each required device size, app description, keywords, support
  URL. The description must set the expectation up front that Shahi needs a
  server you run (see onboarding) — or you invite "doesn't work" reviews.

## Functionality gates before a public launch
- **SSH host-key verification** — currently the tunnel does not verify the
  server's host key (review finding #1, a MITM risk). Ship this before people
  rely on SSH. See `modules/ssh-tunnel/`.
- **Push notifications** end to end — the headline feature; verify real delivery
  on a device (the simulator cannot receive push). See `docs/notifications.md`.
- **Accessibility** — touch targets ≥44pt and labels on icon-only controls
  (partly addressed; audit before submission).

## Build & submit
- `eas build --platform ios --profile production` (not `preview`), then
  `eas submit` — or upload via Transporter. Preview builds are internal only.
