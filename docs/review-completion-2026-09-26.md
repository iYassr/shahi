# September review completion

This continues the prerelease bug hunt and the completed multiple-computer,
core-loop and documentation audits. It covers source changes through the 0.3.8
candidate. The original 128-item bug hunt had 126 source fixes already landed;
this pass fixes the remaining reproduced client and documentation defects and
records the limits below. This is an internal engineering review, not an
independent security audit.

## Verification

All data written during verification belonged to recording fixtures or a new
isolated herdr configuration and named session. No test typed into a user's
agents. Dependency versions were not upgraded.

| Check | Result |
| --- | --- |
| TypeScript, every workspace | Passed |
| Canonical unit suite, including workflows | 1,285 passed, 29 integration/optional skips |
| Dependency regression checks | 4 passed |
| Native component/session tests | 556 passed, 1 skipped, 60 suites |
| Relay tests | 118 passed |
| Browser suite, Chromium and WebKit | 364 passed, 1 skipped |
| Final dashboard/prompt/Inbox/parity rerun | 59 passed |
| Final encrypted hosted multi-computer suite | 68 passed |
| PWA lifecycle/cache suite | 44 passed, 2 skipped |
| Isolated real herdr 0.9.1 adapter | 23 passed; paid-agent and preview cases skipped |
| iPhone simulator release smoke | 1 passed |
| iPhone simulator multiple computers | 5 passed |
| iPhone simulator reader position | 2 passed |
| Native Screen mode, empty reader and reopening | Passed |
| Terminal width controls, default text size and AX5 | 2 passed; resizing emitted no terminal input |
| Web and site production builds | Passed |
| Signed iOS production archive, build 17 | Passed; version, ATS and privacy manifests inspected |

The simulator is an iPhone 17 Pro on iOS 27. Its release native binary was built
from the preceding bug-fix tree; this pass embedded the current production
Hermes bundle. Reader position was checked after the message-layout changes.
Normal-size and AX5 layouts were inspected. Fresh README images use synthetic
conversations only. This does not substitute for a fresh signed-device build or
the physical-device checks in [verify-on-device.md](verify-on-device.md).

## Multiple-computer audit dispositions

Numbers follow the 19 findings in the completed audit, in order.

| Finding | Disposition |
| --- | --- |
| M1, overall connection model | Available/offline/error health, waiting counts, personal names and direct alternatives implemented. No unmeasured “last seen” times are invented. |
| M2, offline computer hides alternatives | Available alternatives are shown in recovery views and connection guidance. |
| M3, background questions invisible | Background waiting count in the switcher and direct waiting-computer actions. Existing push privacy scope is unchanged. |
| M4, duplicate hostnames | Stable duplicate suffixes and saved personal names in both clients. |
| M5, stale actions and scrolling banner | Native persistent unavailable strip; answers and creation disabled while unavailable in both clients. |
| M6, lost uncertain-send status | Notice survives navigation with the original retry identifier; text remains visible during send. |
| M7, ambiguous Computers labels | “Viewing” and “Open agents”; selection no longer implies connectivity. |
| M8, connection cause and retry feedback | Shared cause-specific guidance and existing busy retry feedback retained. No speculative retry countdown. |
| M9, endless Spaces connecting | Uses actual connection health and available alternatives. |
| M10, offline Settings | Saved name, switcher and an explicit unavailable-device-list state. |
| M11, removal wording | Selected computer is named in sign-out confirmation and transport-specific recovery advice. Local removal, relay revocation and all-device access remain distinct operations. |
| M12, lost access | Named access-ended notice, saved-computer chooser and available alternatives. |
| M13, cancel adding | Previous computer survives cancellation and cold launch. |
| M14, pairing identity | “Pair with this computer” no longer implies a verified friendly name before the claim. Personal naming follows pairing. |
| M15, pane context | Native header includes the selected computer; web retains its global computer switcher. |
| M16, misleading LIVE | Request errors produce “Not responding”; availability checks include backend health. |
| M17, AX5 switcher | Computer rows scroll within the sheet, leaving management and Close reachable. |
| M18, SSH form | Numeric keyboard has Done; computer wording and saved-name editing. |
| M19, unstable order | Re-pairing replaces a saved entry in place in both clients. |

## Core-loop audit dispositions

Numbers follow the 22 findings in the completed audit, in order. Suggestions
that conflict with established behavior are distinguished from repaired defects.

| Finding | Disposition |
| --- | --- |
| C1, answered and typed questions | Answer-sent state replaces Waiting; actual text-field options open the focused composer. Identical new questions re-arm by prompt ID. “No, and tell Claude…” is not a text field in the measured terminal menu. |
| C2, one-tap terminal decisions | Retained: faithfully show and send the agent's own options. Keyword-based second confirmations would guess their semantics and alter the established direct-control contract. Agent creation explicitly labels unrestricted starts. |
| C3, large prompt | Bounded scrollable prompt retained; it collapses while typing. Moving every prompt into the thread remains a design alternative. |
| C4, keyboard consumes content | Prompt collapses in Read and is omitted from Screen. |
| C5, offline send | Unavailable writes disabled; text and uncertain delivery remain visible. |
| C6, new agent empty state | Explicit ready-to-write state. Ordering remains latest conversation with pins, rather than an invented message time. |
| C7, permission mode | Checkmark, stronger selected border and “without approvals” start label. |
| C8, full approval cards | Full question, context and option labels retained so permission consequences remain visible; Waiting/search filters narrow the list. |
| C9, pins before waiting | Retained as an explicit product ordering rule. Inbox remains the attention queue. |
| C10, tiny metadata | Native row/action metadata raised to 12 pt and continues to scale. |
| C11, internal labels | Conversation titles and proper agent names in primary headers; waiting terminology improved. Pane IDs remain the necessary fallback for untitled panes; Spaces still reflects herdr's actual tabs/panes. |
| C12, send away from tail | Sending jumps to the newest message. |
| C13, hidden attachment name | Filename previews with removal above the composer; folder/document icons. The exact path remains visible/editable in the text sent to the agent. |
| C14, Inbox meaning | Visible Inbox label and “Mark reviewed” action. Bulk review and Undo are additional features, not implemented here. |
| C15, terminal readability | Duplicate prompt removed from Screen. Existing width controls and exact terminal geometry retained; pinch zoom is not implemented. |
| C16, non-collapsing large title | Compact Agents header. |
| C17, message chrome | Copy control shares the message header; timestamps appear only when the transcript supplies them. |
| C18, stale swipe actions | Close on blur, list drag, row selection and opening another swipe. |
| C19, jump target | At least 44 pt. |
| C20, terminal hotkeys | Retained verbatim: shortening agent-written labels risks losing useful context, especially with a hardware keyboard. |
| C21, hidden file basename | Middle truncation preserves the filename. |
| C22, inconsistent creation action | Solid primary New agent action matches the space screen. |

## Documentation and earlier first-run findings

The three completed documentation audits contained 25 claims, 32 gaps and 19
README findings; the critic added 21 findings and corrected four proposed fixes.
Their factual corrections are applied across CLAUDE.md, the README, mobile
README, privacy copy and the maintained guides. The native reader tail bridge
and workspace-identity checks were implemented instead of documenting permanent
web-only gaps. The two remaining bare-session recovery hints were fixed in
`pairing.ts` and `plugin/bun.sh`.

The critic's corrections were respected: both PWA ports and stub ports are
listed, the Bun realpath measurement is scoped to macOS, the status-report
wording is corrected only where needed, and a proposed arbitrary README length
was not imposed. The obsolete onboarding screenshot was removed; the three
remaining images were replaced. Review discoveries now have a maintained index,
release-note requirements and explicit physical-device checks.

The earlier 23-item first-run report described a build before the landed fixes.
Its applicable input, deep-link, pairing, notification-state, directory and
permission regressions are covered by the corrected flows and existing tests.
Additional checks here covered pairing cancellation, neutral confirmation
wording, computer naming, numeric-keyboard dismissal and visible scrollbars.
Private-key generation/import, sending setup commands to a different device,
and a new notification-onboarding step are feature suggestions, not silently
claimed as delivered. System privacy/permissions pages and verbatim licence
text keep their platform behavior.

## Remaining boundaries

- **B51/B52, Cloudflare zone:** on 26 September, `http://getshahi.dev` still
  returned 200 and TLS 1.0 still negotiated. Existing deployment credentials
  cannot read or write the required zone settings (403); the dashboard needs
  owner sign-in. Enable Always Use HTTPS and minimum TLS 1.2, then verify both
  public hosts. These items are not fixed by an application rebuild.
- **B4, terminal input already queued:** the sidecar checks the foreground
  process and prompt before typing and again before Enter. It cannot recall
  input that reached the terminal queue before the shell starts another program.
- GitHub alert [GHSA-rgj7-g3m4-5g8c](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c)
  remains open for `sharp` in the standalone `demo/package-lock.json` development
  toolchain. The shipped workspaces already pin the fixed 0.35.4. The separate
  demo dependency is unchanged under the current dependency-update hold.
- Real-iPhone push delivery/withdrawal, legacy SSH trust review, iOS cache
  inspection and SSH recovery need the physical-device checklist. Automated
  tests and simulator evidence are recorded separately above.
- Native fixes require a new binary while signed OTA publication is unavailable
  on the current Expo plan. Publication and review status belong to the owner's
  private App Store record, not this public verification report.

The release gate also exposed a timing-sensitive push-expiry test: a renewed
500 ms cookie expired between assertions on a busy Linux worker. The test now
advances a controlled clock through expiry and keeps it fixed during renewal;
the real-time socket-expiry check is unchanged. The actual reader-page builder
also has a regression check for a 1.2 MB synthetic message, beyond the existing
`fitPage` unit tests.
