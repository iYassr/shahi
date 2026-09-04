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

## App Transport Security
- `NSAllowsLocalNetworking: true` is set (`mobile/app.json`), and nothing
  broader. The app makes exactly one cleartext connection — to `127.0.0.1`, the
  local end of its own SSH tunnel — and the relay is `https`. ATS stays
  enforced for every other host.
- It used to be `NSAllowsArbitraryLoads: true`, because a typed tailnet address
  was a way in and no fixed domain could be whitelisted. That transport was
  removed, so the blanket exception went with it — worth knowing because a
  blanket exception is the one App Review pushes back on hardest, and this one
  no longer needs defending.
- **(you)** Verify on a device before submitting: ATS is not enforced
  identically on a simulator, so SSH mode is the thing to exercise. See
  `docs/verify-on-device.md`.

## Privacy
- Published at <https://getshahi.dev/privacy> (`site/public/privacy.html`,
  rendered from `docs/privacy-policy.md` — edit the markdown, then the page).
  **(you)** Link it in App Store Connect, and make sure `privacy@getshahi.dev`
  actually delivers: the policy names it as the contact, and it needs an email
  route on the zone pointing somewhere you read.
- **(you)** Fill in App Privacy "nutrition labels" to match: no data collected,
  no tracking — except the push token (Apple category "Identifiers", used for
  app functionality, not tracking) once notifications ship.

## Accounts & assets **(you)**
- Apple Developer Program membership, app record, bundle id `app.shahi.mobile`.
- Screenshots for each required device size, app description, keywords, support
  URL. The description must set the expectation up front that Shahi needs a
  server you run (see onboarding) — or you invite "doesn't work" reviews.

## Functionality gates before a public launch
- **SSH host-key verification** — **done.** The tunnel now reads the server's
  SHA-256 host key after the handshake and refuses to authenticate if it does
  not match what was stored on first use (trust-on-first-use, known hosts in the
  Keychain). See `modules/ssh-tunnel/` and `mobile/src/lib/tunnel.ts`.
- **Push notifications** end to end — code-complete (registration, blocked-state
  send, tap routing all wired); **(you)** the one unproven step is real delivery
  on a device, which the simulator cannot do. Turn on notifications on the phone
  and confirm a token lands in `expo_push_token`. See `docs/notifications.md`.
- **Accessibility** — **done for the first pass.** Touch targets raised to ≥44pt
  across the key bar, filters, toggles, and chips; icon-only controls carry
  `accessibilityLabel`s; the dancing avatar honours reduce-motion. A full
  VoiceOver pass on a device is still worth doing before submission.

## Build & submit
- `eas build --platform ios --profile production` (not `preview`), then
  `eas submit` — or upload via Transporter. Preview builds are internal only.
