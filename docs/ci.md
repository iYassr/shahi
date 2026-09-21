# CI and releases

Every pull request and push to `master` runs `.github/workflows/ci.yml`.
The `CI required` result succeeds only when every required job succeeds; a
failed, cancelled, or skipped dependency is not accepted. Repository branch
protection must select this status separately; the workflow does not configure
branch protection.

## What a passing run covers

- TypeScript checks across shared, server, plugin, web, mobile, relay, site and operations.
- `bun run test`: unit tests including website signup and operations, plus the dependency boundary checks.
- Local relay Worker tests and mobile JavaScript component tests.
- Three independent browser suites (`e2e`, encrypted hosted connections, PWA),
  each in Chromium and WebKit. Each job builds its own assets and preserves
  its HTML report and failure traces. Focused tests are forbidden in CI and
  failures are not retried into a green result.
- Real isolated herdr sessions for the supported pinned versions and upstream
  stable, including authenticated sidecar routes and shell operations.
- Upgrade, rollback/recovery and compatibility smoke checks on Linux/macOS,
  both ARM64 and x64.

This is not a TestFlight build, physical iPhone test, or paid agent-provider
acceptance run. The credential-dependent live browser and agent tests remain
opt-in; their skipped results do not claim coverage. WebKit emulation is not a
native iOS simulator. Native release testing remains a separate requirement.

## Nightly preview

The preview workflow tests direct herdr contracts and authenticated recovery.
An unapproved preview must remain blocked by the production version gate.
Supported-version CI covers application writes; preview skips those writes
explicitly. A green preview is evidence about those probes, not approval to add
that version to the production support list. Scheduled contract failures notify
the existing issue workflow; installation failures and manual probes do not
file misleading upstream compatibility issues.

## Deployment

The computer-release workflow waits for CI, downloads the exact Linux x64
candidate tested in that run, verifies its source commit, version, size and
SHA-256 digest, then signs and publishes it. It does not rebuild after testing.
An existing immutable version still requires the existing signed-catalog checks;
changing its source requires a version bump. Release credentials remain in the
protected `releases` environment, and publishing is restricted to `master`.

Phone updates are serialized and publish signed, runtime-compatible JavaScript
updates through EAS. They do not upload a new native binary to TestFlight.

Dependabot uses the `bun` ecosystem so manifest updates include `bun.lock`.
Frozen installs remain mandatory. Older npm-configured PRs with manifest-only
updates must be regenerated or have their lockfile updated and reviewed; a red
install on those branches is a real mismatch, not a reason to loosen CI.

## Local checks

Run `bun run typecheck`, `bun run test`, and the relevant browser/relay/mobile
suites. Validate workflow changes with `actionlint`. CI pins Bun 1.3.13, the
release runtime floor, even if a developer has a newer local Bun.
