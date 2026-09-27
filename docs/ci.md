# CI and releases

Every pull request and push to `master` runs `.github/workflows/ci.yml`.
The `CI required` result succeeds only when every required job succeeds; a
failed, cancelled, or skipped dependency is not accepted. Repository branch
protection must select this status separately and require branches to be up to
date before merging; the workflow does not configure branch protection. Keep
the required check name stable when changing the job matrix.

## What a passing run covers

- TypeScript checks across shared, server, plugin, web, mobile, relay, site and operations.
- `bun run test`: unit tests including website signup and operations, the
  workflow-policy and herdr-installer tests in `./.github` (the `./` is what
  makes bun look inside a dot-directory), plus the dependency boundary checks.
- Local relay Worker tests and mobile JavaScript component tests.
- GitHub Actions syntax, expressions, action inputs and job dependencies,
  checked by a pinned, SHA-256-verified actionlint binary. Workflow policy tests
  also protect permissions, signing-key scope and the complete merge gate.
- Three independent browser suites (`e2e`, encrypted hosted connections, PWA),
  each in Chromium and WebKit. The longer scenario suite uses a separate runner
  for each engine. Each keeps one worker and its own mutable stub; increasing
  workers against the shared scenario would make tests interfere. WebKit keeps
  Chromium installed for the signin setup dependency. Each job builds its own assets and preserves
  its HTML report and failure traces. Focused tests are forbidden in CI and
  failures are not retried into a green result.
- Real isolated herdr sessions for the supported pinned versions and upstream
  stable, including authenticated sidecar routes and shell operations. Every
  herdr is installed by `.github/scripts/install-herdr.sh`, which requires the
  GitHub release asset's SHA-256 digest and, for pinned tags, the digest in
  `ci.yml`'s matrix; stable's version and checksum come from
  `herdr.dev/latest.json` and must agree with GitHub. The script never runs the
  binary, and the step that does holds no token.
- Upgrade, rollback/recovery and compatibility smoke checks on Linux/macOS,
  both ARM64 and x64.

This is not a TestFlight build, physical iPhone test, or paid agent-provider
acceptance run. The credential-dependent live browser and agent tests remain
opt-in; their skipped results do not claim coverage. WebKit emulation is not a
native iOS simulator. Native release testing remains a separate requirement.

Hosted and PWA tests probe their local servers before each test and after a
failure. A connection failure is attached to the original result and prevents
later tests from running against dead infrastructure. The run stays failed;
skipped tests provide no coverage. HTTP error responses remain ordinary test
failures, not evidence that a server died. The marker survives Playwright worker
replacement and is cleared for the next run. CI saves Wrangler logs on a browser
or relay failure; inspect those alongside the trace before rerunning a job.
These diagnostics do not fix or hide an upstream Worker crash.

## Nightly preview

The preview workflow tests direct herdr contracts and authenticated recovery.
An unapproved preview must remain blocked by the production version gate.
Supported-version CI covers application writes; preview skips those writes
explicitly. A green preview is evidence about those probes, not approval to add
that version to the production support list. A prerelease has no pinned digest,
so it is checked only against its own release's. Scheduled contract failures
file or update an issue; installation failures and manual probes do not file
misleading upstream compatibility issues. The issue is filed by a separate
`report` job that has only `issues: write`, no checkout, and runs nothing but
`gh`; the job that runs the preview is `contents: read`.

Every checkout in every workflow sets `persist-credentials: false`, so no job
leaves its token in `.git/config` for later steps; `.github/workflows.test.ts`
enforces this for each workflow file, along with the locked EAS CLI below.

## Release catalogs

`catalog-expiry.yml` checks both signed catalogs every Monday and re-signs any
with fewer than 30 days left, filing an issue if it cannot. It never builds or
approves a package. See [releases.md](releases.md) for the commands and
[operations.md](operations.md#release-catalogs) for why a paused schedule
matters.

## Deployment

The computer-release workflow waits for CI, downloads the exact Linux x64
candidate tested in that run, verifies its source commit, version, size and
SHA-256 digest, then signs and publishes it. It does not rebuild after testing.
An existing immutable version still requires the existing signed-catalog checks;
changing its source requires a version bump. Release credentials remain in the
protected `releases` environment, and publishing is restricted to `master`.
The release gate intentionally runs the complete suite again at the selected
commit. PR artifacts are never reused for signing. Release and catalog renewal
share a concurrency lock, so a renewal cannot overwrite a concurrent approval.
Both remove the signing key from the environment after creating a private,
temporary PEM file and delete the file on exit.

Phone updates are serialized and publish signed, runtime-compatible JavaScript
updates through EAS. They do not upload a new native binary to TestFlight. The
EAS CLI that holds the signing key comes from `.github/eas/bun.lock`, frozen
with integrity hashes and installed outside the checkout, and the key leaves
the environment once it is on disk ([releases.md](releases.md#mobile-and-web-rollout)).

Dependabot uses the `bun` ecosystem so manifest updates include `bun.lock`; it
watches `/.github/eas` separately for the locked EAS CLI.
Frozen installs remain mandatory. Older npm-configured PRs with manifest-only
updates must be regenerated or have their lockfile updated and reviewed; a red
install on those branches is a real mismatch, not a reason to loosen CI.

## Local checks

Run `bun run typecheck`, `bun run test`, and the relevant browser/relay/mobile
suites. Validate workflow changes with `bash .github/scripts/check-workflows.sh`
(Linux x64 or Apple Silicon), or actionlint 1.7.12 directly on other platforms.
The workflow checker does not claim shellcheck or Python lint coverage.
CI pins Bun 1.3.13, the release runtime floor, even if a developer has a newer
local Bun. Linux runners name Ubuntu 24.04 explicitly, including the release
candidate producer. Moving to another Ubuntu major is a reviewed workflow
change rather than an automatic `ubuntu-latest` migration.
