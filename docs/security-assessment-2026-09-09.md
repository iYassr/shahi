# Relay and managed-update review — 9 September 2026

This maintainer review covers the relay, computer recovery endpoint, signed
release catalog, updater and publication workflow for Shahi 0.3.2. It combines
source review, adversarial regression tests and actual GitHub environment
inspection. The baseline was 0.3.1 (`a80d07b4`). It is not an independent audit.

## Findings and fixes

### Device revocation while an update body arrives

The recovery endpoint checked the device before awaiting its request body.
A previously authorized device could begin a request, be revoked, then finish
the body and still enqueue an approved service update. The regression received
202 before the fix; it now receives 401 and creates no update request. Access
to subsequent recovery requests is also refused. This did not allow arbitrary
downloads or commands: signature and release selection remained enforced.

Authorization is now checked again immediately before publishing the durable
action. Unsupported fields, including URLs, commands and requested versions,
are rejected. A pending action cannot be overwritten by a second request.
Already accepted updates are owned by the local manager and finish normally.

### Closing relay sockets could interfere with live replacements

Cloudflare can retain closing sockets in `getWebSockets`, and those sockets
can deliver late messages. Our old lookup selected the first socket with a
link tag, including a departed phone, so a replacement phone could receive no
traffic. Closing computer sockets also reverted to the unauthenticated state:
a repeated valid authentication could evict a replacement, and expired pending
sockets could keep scheduling an alarm in the past.

The isolated lifecycle harness reproduced all four failing behaviors, including
authentication accepted after its deadline when the alarm had not fired.
Computer closure is now terminal, lookups select live phones, authentication
rechecks state after asynchronous verification, and deadlines exclude closed
sockets. Late phone closure cannot close a replacement link. Pending computer
authentication is capped at eight per computer identity without evicting the
authenticated computer. Real Worker tests exercise that quota.

These are availability and lifecycle defects, not evidence that relay traffic
could be decrypted. The runtime's newer automatic close handling reduces the
window but does not justify treating closing sockets as live.
[Cloudflare socket lifecycle](https://developers.cloudflare.com/durable-objects/api/state/#getwebsockets).

### Release signing environment allowed any branch

GitHub's `releases` environment had no branch restriction. It now permits only
the `master` branch, and both signing workflows check that ref. All third-party
Actions in the release and test workflows are pinned to full commit hashes.
Signing jobs no longer persist the repository write token in checkout config.
The full compatibility, recovery, relay, native and browser CI remains required
before the publication job can run.

This reduces branch and mutable-action exposure. It does not remove the trust
placed in repository maintainers, the signing account, GitHub or the local
machine holding the private key. Anyone able to change trusted release code
can change the release itself. [GitHub Actions security guidance](https://docs.github.com/en/actions/reference/security/secure-use).

### Release metadata and dependency hardening

Signed manifests previously admitted `.` and `..` as build directory names.
Those names, path separators, duplicate build identifiers and prereleases in a
Stable catalog are now rejected. Staging validates the manifest before any file
access. These checks catch unsafe signed metadata; they are not a signature bypass.

Sharp is upgraded to 0.35.4, including Miniflare's transitive copy, for
[GHSA-rgj7-g3m4-5g8c](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c).
The affected library belongs to build/development tooling, not the deployed
relay. The dependency audit still reports three advisories for the two packages
with tested local backports; they are documented in [patches](../patches/README.md).
Those reports are not suppressed and the raw audit does not exit cleanly.

## Verification

- Wrong secrets, tampering, replay, reflection and frames from old connections
  are rejected by the encryption tests. Box challenge replay and cross-computer
  traffic isolation are exercised against the actual local Worker.
- Unproved device hellos expire without receiving dashboards. Revocation
  between hello and proof refuses the session. A pairing connection cannot
  access normal authenticated routes or computer recovery.
- Catalog signatures, trusted keys, channel binding, expiry, sequence replay,
  security floors and archive checksums are tested. Traversal and altered
  archives are refused before activation.
- The actual manager smoke test exercises signed downloads, failed readiness,
  rollback, preserved pairing and recovery after supervisor interruption, using
  disposable state and a recording herdr stub.
- Local validation: 618 unit tests passed, 26 opt-in live tests skipped;
  68 relay tests and four dependency backport checks passed. All TypeScript
  projects passed. Publication also runs the four-platform upgrade matrix and
  native/browser compatibility suites in CI.

Attack fixtures use synthetic credentials and isolated local servers. No
production traffic flood, user terminal write or real pairing revocation was
performed by these tests.

## Verified rollout

[Shahi 0.3.2](https://github.com/iYassr/shahi/releases/tag/v0.3.2) is published
on Stable from source `f2fbae319aefef293dab2f65bf26b81499e9bab7`.
The [release approval workflow](https://github.com/iYassr/shahi/actions/runs/34317652039)
passed every job: four OS upgrade targets, both herdr versions, 254 native
tests, 184 direct browser checks and 38 hosted browser checks, plus types and
the unit/security suites. After the approved Beta package passed installation
on the Mac, its exact verified bytes were promoted to Stable by signing the
channel catalog; the versioned package was not rebuilt or replaced.

The Mac and separate Ubuntu server both report running build
`0.3.2-f2fbae319aef` on Stable, connected to herdr and the relay. Their server
identities and paired-device digests match the pre-update records.
The relay is deployed as Worker version `f94f9ea3-441b-4117-8386-f023ecf6c2d0`;
the hosted web deployment is `f3cf097f-8228-4bbb-845d-28b5a91b3bba`, with public
shell and asset bytes checked against the build. GitHub's repository policy
also now requires full commit hashes for third-party Actions.

## Boundaries that remain

The relay can deny or delay service and observe connection metadata. Per-IP
and per-computer quotas reduce abuse; they are not a global spending cap or a
guarantee against distributed denial of service. Hosted browser code and its
distribution origin remain trusted with device secrets and decrypted content.

The first plugin installation trusts the herdr/GitHub distribution path and
the Bun installer; subsequent service packages are checked against pinned
release keys. Private manager state assumes a trusted local OS account. The
updater cannot defend against an attacker who already controls that account
or its signing keys. Fresh installations cannot detect a still-valid older
catalog they have never superseded; installed machines retain monotonic
per-channel sequence numbers. Catalogs must be renewed before their 120-day
expiry. A failed check retains the working service.

Signed phone OTA configuration is present, but publication remains unavailable
on the current Expo Free plan. Native binary distribution is the active phone
update path. Account MFA, independent cryptographic review and large-scale
production attack resistance are outside this verification.
