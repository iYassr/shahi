# Shahi releases

Shahi is one managed product. Apps speak only Shahi routes; the computer service
adapts herdr. The plugin installs and supervises approved releases. Relay service
is operated by Shahi and SSH libraries travel inside the phone binary.

## Compatibility policy

- Keep the current and previous Shahi API generation, with at least 90 days
  after the successor reaches Stable before retiring the previous generation.
  A security retirement may be immediate and must have an explicit release note.
- The initial safe floor is API 5. API 4 and earlier are **not** restored.
  Current and baseline clients both use API 5; additive features do not bump it.
- Advertise additive capabilities in the authenticated control handshake.
  Missing attachments disable attachment controls; missing managed updates
  leave ordinary supported app features available.
- Recovery protocol 1 is independent of the ordinary API. Keep it available
  through the same authentication, origin checks and encrypted transport when
  herdr is offline or unsupported. It cannot bypass a revoked device grant.
- The encrypted transport floor is 2. There is no insecure relay fallback.
  Supporting infrastructure must be deployed before clients need a new transport.
- herdr 0.9.0 and 0.9.1 / protocol 22 are tested adapter profiles. A new herdr
  version enters the approved list only after the live adapter suite passes.
  Unsupported herdr leaves recovery and pairing available, but refuses commands.

`shared/src/compatibility.ts` defines app support. The adapter profiles live in
`server/lib/backend.ts`; release requirements live in
`plugin/releases/release.json`. CI checks their agreement and exercises the pinned
pre-managed service (`393e012fc8bf3ec100cddb342f61a6dd8b2db9f2`) and the packaged
current service using an isolated recording socket. No real agent is used by
the upgrade suite. The independent live-herdr matrix uses a named test session.

## Approved computer releases

The plugin selects the signed Stable catalog on first install. Reinstallation
restarts the supervisor and requests the latest compatible approved release.
Running code comes from the verified package, never the mutable plugin checkout.
The package contains the service, manager and computer-hosted web app. Its manifest
pins the source commit, build identifier, archive digest and size, supported
platforms, Bun minimum, herdr profiles, API range, encrypted transport, recovery
and manager contracts, and data format. EAS separately records immutable native
builds and update groups; they are compatible by API and native runtime rather
than having to share the computer's release number.

Stable and Beta catalogs are signed with Ed25519. Public keys are pinned in
`plugin/releases/trust.ts`; private keys belong outside the repository and in
the GitHub `releases` environment. Channel catalogs are the only mutable release
assets (`shahi-stable/catalog.json`, `shahi-beta/catalog.json`). Versioned service
assets are never overwritten. Catalogs expire after 120 days. Network errors,
expiry or invalid signatures leave the running release alone and explain why
update checking failed. Per-channel sequence numbers prevent replay after a
newer catalog has been seen.

Renewal re-signs the same approved releases with a later expiry and a higher
sequence, and needs no version bump or test run:

```sh
bun plugin/releases/sign.ts renew stable|beta <key.pem> <out.json> <previous.json> [--retire v1,v2]
bun plugin/releases/sign.ts due stable|beta <catalog.json> <days>   # prints true when it expires within <days>
```

`.github/workflows/catalog-expiry.yml` runs it every Monday at 05:23 UTC for
any channel with fewer than 30 days left, and files a "Release catalog renewal
failed" issue when it cannot. Dispatch it by hand to renew now, or to withdraw
versions with `retire` (each must be in every channel chosen), which re-signs
at once. GitHub pauses scheduled workflows after 60 days without repository
activity, so keep it enabled. Nothing watched the date before the
pre-public-release review, and the first catalogs would have lapsed on
2027-01-18, stopping every fresh install in bootstrap.

Signing keeps every release some computer could still select and drops entries
a newer release supersedes: same data schema, all of its platforms and herdr
profiles, no newer bun required and no higher `api.min`. `--retire` withdraws a
version explicitly. More than 50 selectable releases fails signing with its own
message rather than producing a catalog every computer would refuse.

The messages a computer shows for a bad catalog name the problem: "Release
catalog is invalid.", "Release catalog is older than one this computer already
accepted.", "Release catalog is dated in the future. Check this computer's
clock.", "Shahi's signed release catalog expired on <date> and has to be
renewed by Shahi. An installed release keeps running.", and "Release catalog
lists N releases, more than the 50 a computer accepts." A release that does
not fit the machine is refused with a reason naming the platform, bun or herdr
versions on both sides.

To release: bump `plugin/releases/release.json`, `herdr-plugin.toml` and
`server/package.json` to the same version (a test enforces it; `/api/meta`'s
`serverVersion` and `shahi.status` report it), run the release matrix, then
merge that tested commit to `master`, then run **Approve Shahi release** there.
The release environment permits only the `master` branch; signing jobs also
check that ref. Third-party build actions are pinned to full commit hashes, and
every checkout in every workflow sets `persist-credentials: false`. Publish to
Beta first, which stays a GitHub prerelease. After observing successful
upgrades and reconnects, promote the same immutable package to Stable; a Stable
approval also marks the GitHub release Latest (`--prerelease=false --latest`).
Stable approvals before that change left GitHub's Latest on v0.3.1; the next
one corrects it, or `gh release edit <tag> --latest` does by hand. Never
replace an existing version with a rebuilt archive.

## Update and recovery

The OS supervises a small manager in the plugin's state directory. It owns the
active release pointer and a durable activation journal. The server can request
only `check` or `install`, optionally selecting Stable or Beta; it cannot provide
a download URL or shell command. A signed catalog chooses the target.
Unknown request fields are rejected, and device authorization is checked again
after the request body arrives, immediately before publishing the update action.

The manager downloads with a byte limit, verifies the complete archive, checks
every path, stages it separately, and then restarts the service. Readiness checks
the **running** build, authenticated recovery, web assets, preserved server
identity, and the backend snapshot when supported herdr is available. Offline
herdr still permits recovery-only readiness. Pairing secrets and databases stay
outside release directories. A failed activation restores the previous release;
an interrupted activation resumes from its journal at the next manager start.
An approved manager update is installed atomically after service readiness and
the OS restarts it. Only the active and immediately previous artifacts are kept.

Data schema 1 currently permits same-format rollback. Different schemas are
refused until a separately tested migration and recovery path is introduced.
Rollback never copies an old database over newly created pairings or messages.
herdr itself is never updated or restarted by this manager: doing so may disrupt
running sessions. The app explicitly directs that separate update when needed.

Phones installed before recovery protocol 1 require one bootstrap reinstall of
the computer plugin. This cannot be done remotely through an endpoint that those
older services never shipped. Existing pairing is preserved through that install.

## Mobile and web rollout

The phone uses Expo runtime fingerprints and a pinned RSA signing certificate.
Compatible JavaScript fixes can ship to 10%, then 25%, 50% and 100% of a channel.
Native changes require a new binary and a matching fingerprint. Updates apply
on the next launch; never reload someone in the middle of composing a message.
Use EAS `update:edit` to expand a rollout and `update:revert-update-rollout` to
stop a bad one. Certificate rotation requires a new trusted binary.

The **Signed Shahi phone update** workflow requires an Expo token, the private
signing key, and Expo Production or Enterprise. As checked on 2026-09-09, this
project is on Free: signed publication is unavailable until that account change.
While it holds the key, the workflow runs eas-cli 23.2.0 from
`.github/eas/bun.lock`, a lockfile frozen with integrity hashes and installed
in `$RUNNER_TEMP`, and unsets the key from the environment once it has written
it to a 0600 file, so the build eas-cli spawns does not inherit it. The lockfile
is not a workspace dependency: in the app's tree eas-cli's older
`@expo/config` would be hoisted over SDK 57's and change what the phone is
built from, and inside the checkout Metro would crawl it. To move eas-cli, edit
`.github/eas/package.json` and regenerate its lockfile with the CI bun (1.3.13)
in a directory outside the checkout, or merge the Dependabot pull request for
`/.github/eas`.
The certificate is configured in new binaries; unsigned OTA is never accepted.
See [Expo runtime versions](https://docs.expo.dev/eas-update/runtime-versions/),
[code signing](https://docs.expo.dev/eas-update/code-signing/) and
[rollouts](https://docs.expo.dev/eas-update/rollouts/).

The hosted web build deploys after supporting computer changes. Clients keep
their saved computers during update/reconnect and can switch to another live
computer. An absent capability disables its optional control, rather than forcing
an unrelated component update. In Settings, users choose a channel or check for
an update; the main screen shows update availability and recovery progress.

### herdr 0.9.1 verification — 2026-09-16

The official macOS arm64 binary was checked against the release asset’s SHA-256
digest and exercised in an isolated named session. The live adapter suite passed
21 checks; the optional test that starts a paid AI agent was not run. An initial
shell-submit timeout passed on rerun with the same binary and configuration.
Protocol 22 is unchanged. The schema adds only `pane.link.resolve` and its
response; existing calls retain their shapes. Generated types include the new
schema. CI pins both 0.9.0 and 0.9.1, by tag and by the SHA-256 digest of
their `herdr-linux-x86_64` asset, and also tests the current stable release,
checked against `herdr.dev/latest.json` and GitHub's digest.

These source changes need a new approved Shahi service release before managed
installations accept herdr 0.9.1. Publishing the landing page alone does not
update the computer service.
