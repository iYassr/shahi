# Reader acceptance on clean Linux, September 29, 2026

This records measured results, not a claim that every Reader failure is covered.
The disposable OrbStack machines and their QA folders are retained for follow-up.
No herdr agent integrations were installed on any of these machines.

## Installation matrix

| Machine | System | Architecture | Fresh install | Reader regression suite |
| --- | --- | --- | --- | --- |
| `shahi-clean-0929` | Ubuntu 26.04.1 | ARM64 | Passed | 206 passed |
| `shahi-clean-debian-0929` | Debian 13.7 | ARM64 | Passed | 198 passed |
| `shahi-clean-x64-0929` | Ubuntu 24.04.5 | x86-64, emulated | Passed | 198 passed |

Each started without herdr, Bun, agent configuration, or hooks. Host file sharing
and SSH agent forwarding were disabled. The documented herdr installer installed
herdr 0.9.1; `herdr plugin install iYassr/shahi --yes` installed Shahi and Bun 1.4.2.
The headless Debian and x86-64 servers needed Shahi's documented restart action
to run setup because starting a headless server did not run the UI startup hook.
Both then reached an active systemd user service and connected tunnel. This was
not an interactive first-launch test of herdr's desktop UI.

The plugin checkout was 0.3.14 at `13ee15e`, but the verified stable service it
installed was **0.3.8-5748ecbe4beb**. A newer plugin manifest does not prove a
newer signed computer release is available. Check `/api/control/handshake`.

## Published service versus the candidate

The Ubuntu ARM machine was paired to the hosted PWA through the real encrypted
Shahi tunnel. Empty Agents/Spaces views and creating a workspace worked. Agent
discovery found Claude Code 2.1.284 and Codex 0.158.0 after installation without
restarting Shahi. All 18 integration status entries remained uninstalled.

| Check | Published computer service | Candidate |
| --- | --- | --- |
| New Codex Ask me conversation | Prompt and real reply worked in Screen; Reader returned 404 | Reader showed the exact conversation without hooks |
| New empty conversation ordering | Appeared below the older conversation; no `startedAt` | New conversation appeared first |
| Codex embedded-server trust menu | Quit/footer variant was not parsed | Correct trust card, with strict negative cases retained |
| A supported Reader temporarily returns 404 | Web switched away to Screen | Read stays open, polls, and fills automatically |
| Codex `/new` | Not exercised on this old launch | Temporary ambiguity returned 404; once one exact rollout remained, the new conversation appeared |
| Four Codex permission modes | Only Ask me measured here | Each completed a harmless prompt, with a distinct exact session and marker |
| Computer candidate restart | Not exercised for comparison | Browser reconnected and retained the correct conversation |

Published Codex attached to a shared background daemon: the pane's process had
no open rollout, so exact process-file lookup could not identify its transcript.
The candidate's per-invocation approval reviewer setting starts an embedded
server and makes that exact lookup work. Existing daemon-backed sessions do not
move into the new process model when Shahi updates; start a new conversation.
Never compensate by choosing the most recent transcript in the working folder.

The candidate was the public Reader branch at `4d39296`, with the trust-menu
parser correction applied afterward. It temporarily replaces only the service
in this disposable VM. It runs without `SHAHI_MANAGER_ROOT`, so the managed
integration installer is deliberately not exercised. The same private config,
database and tunnel identity are retained; no secrets are included in this report.

## Regression coverage

The clean Debian and x86-64 runs each passed the same ten Reader suites: Claude,
Codex, Cursor, OpenCode and Antigravity parsing, Codex indexing/items/media,
transcript watching, and Claude conversation selection. They covered 198 tests
and 716 assertions per architecture. The Ubuntu ARM run also included the exact
session ownership and conversation-provider routing suites: 206 tests, 763
assertions across twelve files.

These exercise malformed and unknown records, append/truncate/replacement,
bounded windows and pagination, exact identity and ambiguous-path refusal,
tool/result rendering, provider-specific rewrites and undo, and watcher recovery.
They are synthetic and captured-record tests; they do not authenticate every
provider on each machine.

The combined release also passed the canonical unit/dependency checks and the
native JavaScript component suite. Its browser check through the encrypted
hosted fixture at a 390-pixel viewport verified both OpenCode and Antigravity:
the written answer, questions and failed steps stay visible, while routine
activity expands on demand, without horizontal overflow. Antigravity's herdr
kind `agy` is normalized for Reader availability and diagnostics.

The combined Reader, ordering and resilience browser matrix then ran on the
Ubuntu x86-64 VM in Chromium and WebKit: **52 passed, one intentionally skipped**
in 6.9 minutes. The skipped case is offline navigation with a service worker,
which this WebKit harness cannot emulate; Chromium covered it. The run used the
tracked archive at `62a9373`; later changes were native-only and documentation.

The combined PR's full browser jobs exposed one shared fixture failure: the
deliberate render crash attempted to send a Sentry report, which the external
write fuse correctly blocked. Capturing that exact ingest request locally
preserves the fuse and keeps synthetic incidents out of production diagnostics.
The crash test now checks the actual SDK envelope for privacy filtering.
The complete app spec then passed in both engines on the x86-64 VM:
**21 passed in 1.3 minutes**, including sign-in setup. This focused rerun is
separate from the full CI matrix.

During test preparation, assigning an entire SessionLog where the stub expects
its message array produced a 500. Correcting that fixture restored the check;
this was not a product defect. A hidden browser tab also paused Reader polling
as designed; foreground emulation was needed for the browser acceptance run.

## Independent update recovery

The combined release adds an expiring frontend update requirement served by the
website, independent of the computer API. Its default policy requires nothing.
The hosted fixture verified blocking an older browser build, preserving the
mounted screen, refusing reload when the deployed bundle was unchanged, and
immediately removing the requirement after a disabled policy arrived. Shared
tests cover outages, invalid responses, cached policies, expiry and a slow
storage restore racing a fresh revocation. Native component tests cover store
links, revocation and stopping dictation while the update screen is shown.
See [client-updates.md](client-updates.md) before activating a requirement.

## Remaining acceptance work

- An authenticated Claude conversation on the fresh Linux machine needs the
  owner's OAuth consent. Its first-run screen was exercised; real Claude
  conversation reading is not yet proven on this machine.
- The native iPhone app still needs to be paired with the fresh Linux server
  and checked for Reader loading, scrolling, background recovery and push.
- The new Apple dictation engine needs the physical-device checklist in
  [voice-input.md](voice-input.md). Its iOS Swift sources typecheck, but this
  review Mac could not run SpeechTranscriber and no microphone result is claimed.
- The Mac's new Xcode and browser processes exited during OS startup before
  compilation/test execution. The browser matrix passed in the disposable
  Linux VM instead. This is not counted as a passed native build or device test.
- Native-only gestures, Dynamic Type layout and VoiceOver require device checks;
  component tests and a phone-sized browser do not substitute for them.

Keep raw sign-in logs, authentication caches, pairing codes and release signing
material outside Git. Public evidence should contain test outcomes and synthetic
markers only.
