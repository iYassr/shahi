# Client observability

Shahi uses Sentry for optional client crashes, application errors and persistent
Reader failures. Cloudflare operational monitoring continues to cover the relay
and public services; it cannot see whether a phone rendered a conversation.

Projects: `yasser-dx/shahi-mobile` and `yasser-dx/shahi-web`, in Sentry's EU region.
The enabled **Shahi errors and Reader failures** email alert covers both
projects, triggers for new/regressed or newly high-priority issues at warning
level or above, and throttles repeats for the same issue to once per three hours.
Recovery events are informational and do not trigger that alert.

Public DSNs are in `shared/src/diagnostics-config.ts`. They accept reports and are
not administrative credentials. Never put an auth token in the app or repository.

## Privacy and user control

**Share diagnostics** is on by default in Settings. The native preference lives
in UserDefaults so it applies before JavaScript starts. The web preference is
local to that browser. Disabling it stops new reports; it does not erase reports
already received or disable separate relay/Apple/Expo diagnostics.

JavaScript events are rebuilt from an allowlist in `shared/src/diagnostics.ts`.
Native crashes bypass JavaScript, so `mobile/plugins/sentry-native.swift`
initializes Cocoa with its own filter. Keep both boundaries. No conversation
text, terminal output, file paths, credentials, connection IDs, account IDs,
console breadcrumbs, screenshots or replays are sent. An error keeps its type,
its mechanism (signal, Mach exception, NSError domain and code) and its message
with links, email addresses, paths, long numbers, long identifiers and quoted
text replaced by placeholders (`redactErrorMessage`; `sentry-redaction.swift`,
checked against the same vectors by `mobile/plugins/tests/run.sh`). Messages
were once dropped whole, and a fatal crash reached Sentry as "Native
application error (message omitted for privacy)" with nothing to act on. Code
positions, software versions, fixed failure categories, retry counts and timing
remain useful without that content. Sentry adds source code context from the
release's uploaded maps; those contain Shahi's code, never customer transcripts.
The projects also enable server-side scrubbing and prevent IP-address storage.

## Reader incidents

The five installed providers are covered: Claude, Codex, Cursor, Antigravity and
OpenCode. A failure must persist for at least 30 seconds and three attempts in an
active, connected Reader view. Each streak reports once; a successful response
reports recovery once. An oversized response reports immediately because the
client intentionally backs off polling. Fresh conversations without known
history, background/disconnected views, unsupported providers and authentication
or incompatible-server responses are excluded. Each reporting path caps reports
at 20 per hour (native and JavaScript have separate budgets). This diagnoses failures that occur while Reader is open, not all
agents continuously in the background.

## Free plan

Use error monitoring and email issue alerts. Replay, tracing, profiling, logs,
metrics and paid AI features are disabled in the clients. New Sentry accounts
start with a free Business trial and return to Developer when it expires without
a paid subscription. The initial organization has no payment method. Verify the
current quota and billing page before changing products; Developer currently
includes 5,000 errors/month, so reports may be dropped when the quota is exhausted.
Do not promise complete fleet coverage or zero missed errors on that quota.

## Release artifacts

- `SENTRY_AUTH_TOKEN` is a scoped `org:ci` organization token, kept only in the
  GitHub `releases` environment or a private local build environment.
- `bun run build:web` injects debug IDs and creates hidden source maps. The maps
  and corresponding JavaScript go into `dist/sentry/computer/`, outside the
  served files. The hosted build uses `dist/sentry/hosted/`. With the token set,
  Vite uploads them and fails if upload fails.
- CI builds without secrets and preserves matching debug artifacts separately
  from the tested computer package. The trusted release job uploads those exact
  artifacts before publishing. Never expose signing/upload tokens to PR jobs.
- The Expo plugin uploads the native build's JavaScript maps and dSYMs during
  a release archive. Provide the token to that build. The private Sentry plugin
  must precede the upstream Sentry plugin in app.json: its Xcode mod runs last
  and loads `.xcode.env.local` before resolving Node, including when Xcode is
  opened from Finder. For a GUI archive, keep upload credentials in a private
  properties file outside the repository and export only its `SENTRY_PROPERTIES`
  path from `.xcode.env.local`; build scripts can trace environment commands.
  For an unsigned compilation check only, `SENTRY_DISABLE_AUTO_UPLOAD=true`
  skips upload.
- The signed OTA workflow uploads its generated `mobile/dist` maps with the
  locked Sentry CLI. If that step fails, retry the upload from the same output;
  do not rebuild or republish an OTA just to repair symbolication.
- Adding Sentry and its native settings module changes Expo's fingerprint. An
  older binary needs a new native TestFlight build; this cannot be delivered to
  build 25 as a JavaScript-only update.

## Verification before release

Run the repository types, unit tests and mobile tests. Reader component tests
cover all five providers, repeated failures, recovery, offline/background states
and disabled reporting. Privacy tests inject synthetic secrets into nested SDK
fields and verify only allowlisted metadata survives.

Build a native Release archive and check source-map/dSYM upload. On a disposable
test session, provoke a Reader failure and recovery and verify the fixed tags in
Sentry. Confirm a JavaScript error maps to an original Shahi source line and a
native error is symbolicated. Inspect the outgoing envelope and stored event:
no prompt, filename, credential, user identifier or IP address should appear.
Disable diagnostics, repeat, and confirm that no new events are sent. Verify
email alerts for warning/error issues and their throttle. Keep synthetic tests
under `verification` and distinguish them from real user incidents.
