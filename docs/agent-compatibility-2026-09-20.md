# Agent compatibility checks — 20 September 2026

This checks the working tree after the TestFlight build 12 release. The changes
below have not yet been deployed to the production plugin or a new iOS build.

> *Note, 23 September 2026:* the "native PDF attachment check through the
> encrypted fixture" below passed against a fixture that forwarded every
> response header. A real sidecar forwarded only `content-type`, `etag` and
> `cache-control` through the relay, so the same flow failed there with "The
> computer returned an incomplete file." The sidecar now forwards the ranged
> download's headers too (`RELAY_RESPONSE_HEADERS`) and the fixture filters by
> the same list. The check needs repeating against a computer release newer
> than 0.3.6 before it counts as evidence.

## Scope

The native iOS 27 simulator and both Chromium/WebKit browser engines exercise
all 24 kinds recognized by Shahi's creation matrix. Each kind is created from
Agents and Spaces. Claude and Codex exercise all four offered permission modes;
other kinds use their provider defaults, without invented permission flags.
The synthetic fixtures validate app behavior and request payloads, not provider
availability. See `e2e/native/creation-matrix.ts` and `e2e/agent-matrix.spec.ts`.

Live checks use herdr 0.9.1 on Ubuntu. Agent creation and messages target a named
session under a fresh `XDG_CONFIG_HOME` with no Shahi startup hook. Existing
conversations are read-only. Terminal/transcript content and credentials are
not included in this report or test logs.

## Real providers

All twelve installed agent/mode combinations created distinct panes with the
expected process arguments. One harmless prompt per provider tested delivery;
permission-mode checks confirm the actual flags, not every possible tool action.

| Agent | Modes checked | Result and limit |
| --- | --- | --- |
| Claude | 4 | Startup, flags, delivery and existing Read transcripts passed. Fresh replies hit a provider usage limit. |
| Codex | 4 | Startup, flags, distinct sessions, delivery and existing Read transcripts passed. Fresh replies hit a provider usage limit. |
| Cursor | Default | Startup and delivery passed. The new isolated session requested login. Two existing real conversations supplied messages and tool calls in Read. |
| Antigravity (`agy`) | Default | Startup, delivery and an actual requested reply passed. Uses Screen; no structured transcript adapter is claimed. |
| OpenCode | Default | Startup, flags and prompt delivery passed. A completed reply was not confirmed. Uses Screen. |
| Pi | Default | Startup and delivery passed; provider authentication was required. Uses Screen. |

Copying existing Cursor/OpenCode configuration into the private test environment
did not establish a successful reply from those providers. Authentication and
usage-limit states must not be counted as successful model completions.

Read-only checks on the real server found readable messages and tools in two
conversations each for Claude, Codex and Cursor. The dashboard inspected 116
panes: 12 Claude, 9 Codex and 2 Cursor conversations had available message dates.
Both successive dashboard reads sorted these newest-first. Other panes without
a readable message date keep stable positions after dated conversations.

## Bugs fixed

- herdr can acknowledge a launch before accepting input. Shahi now checks that
  same agent's readiness before returning success, within its startup deadline.
  A permission question opens immediately so the user can answer it. Neither
  waiting nor timing out launches a duplicate agent.
- The web app no longer permanently removes Read after an initial missing
  transcript. The user can reopen Read once a new agent has written messages.
- Older flat Cursor transcript paths now retain their actual session ID.

## Verification

- Full source suite: 710 passed, 26 opt-in checks skipped; dependency checks: 4 passed.
- Native component/unit suite: 327 passed across 40 suites.
- Browser agent matrix: 120 cases passed plus sign-in, in Chromium and WebKit.
  Each checks creation, navigation, selected permissions, Read/Screen, and one
  message request directed to the newly created conversation.
- Existing browser dashboard/prompt/parity regression: 45 passed.
- Late-transcript Read recovery: both browser engines passed.
- Targeted readiness and Cursor regressions and repository type checks passed.
- Signed iOS 27 simulator Release build succeeded.
- Native PDF attachment check through the encrypted fixture passed: both sample
  pages rendered in PDFKit and Save / Share opened the iOS share sheet. Screenshots
  were visually inspected; saving to a destination was not exercised.
- Native creation matrix: all 60 cases passed through the encrypted fixture,
  including both entry points and all offered permissions. Each opened its new
  conversation and produced exactly one matching creation request.
- Incoming-message reordering with a pinned conversation passed in both browser engines.

The 18 agents not installed on the real server have app-contract coverage, not
live-provider coverage. Physical-device behavior and successful paid-provider
work under every permission mode are not established by this run.

## Cleanup

The isolated live herdr session and all its test agents were stopped. Private
configuration copies and test files were removed from the server. Provider tools
may retain synthetic test conversations in their own normal history directories.
No production service was restarted, and no messages were sent to existing work.
