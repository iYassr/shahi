# Mobile conversation and connection recovery

The September 22 changes keep the Read/Screen controls below the native header,
so long titles cannot obscure them on iOS 27. Terminal output applies independently
of transcript loading. The selected mode and reading position remain remembered.

During a connection interruption, loaded messages remain visible. A failed
refresh must not replace a cached conversation with the no-transcript screen.
Unsent drafts remain associated with the same computer and conversation for the
current app session; this is not disk persistence after force-quitting the app.
Recovery never sends a draft automatically. Uncertain sends retain their operation
ID for an explicit retry, and revoking a computer clears its drafts.

Connection messages distinguish a phone without network access from a
relay-confirmed disconnected computer. A generic interruption shows
“Reconnecting to [saved computer name]…” without guessing that the computer is
asleep. The initial network snapshot cannot override a newer connectivity event.
Switching computers clears the previous computer's temporary retry feedback.

## Verification

- Mobile component tests and repository type checks.
- `e2e/native/screen-mode.ts`: iOS 27 simulator; long Codex title, missing
  transcript, repeated mode changes, reopening Screen.
- `e2e/native/read-live-conversation.yaml`: reusable read-only scroll flow.
  This release also exercised it against an isolated encrypted fixture with
  140 messages, paging beyond the initial 60 and preserving the anchor through
  mode changes and reopening before jumping to the actual final message.
- `e2e/native/reconnect.ts`: isolated encrypted connection outage; cached
  conversation and draft remain visible after reopening offline; automatic
  recovery preserves both and sends no prompt.
- `e2e/connection-health.spec.ts`: Chromium and WebKit verify network recovery
  and draft retention after a failed wake-up authentication check.

Native fixture tests require an installed Release simulator build and
`HOSTED_PORT=7894 bun e2e/hosted/server.ts`, then `SIMULATOR_UDID=<test-device>
HOSTED_PORT=7894 bun e2e/native/reconnect.ts`. They never disconnect or write into
a customer's computer. These checks do not replace physical-device testing.

## TestFlight delivery

Build `1.0.0 (14)` contains the Screen/loading fixes from `f53ac38`.
Build `1.0.0 (15)` adds the connection-recovery changes from `d739f3e` and is the
build to install for both improvements. Both were built from clean checkouts
with Xcode/iOS SDK 27; their embedded privacy manifests were checked.

The queued EAS submission for build 14 was canceled before direct upload to
avoid duplicate submissions. Apple's local uploader accepted both binaries.
After applying the unchanged build-13 encryption classification and existing
no-France scope, App Store Connect reported `VALID` and `IN_BETA_TESTING` for
both builds on September 22. This is an internal TestFlight release; external
beta review remains `READY_FOR_BETA_SUBMISSION`.

The release source passed all 334 mobile tests, 85 shared tests, the native
regressions above, both browser-engine recovery checks, and GitHub CI run
`35657696906`. Signed archives and upload credentials remain outside the repo.
