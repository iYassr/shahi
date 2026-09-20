# Web and mobile UI/UX audit — 18 September 2026

Shahi's visual identity is consistent across the two clients: warm dark surfaces,
amber actions, colored provider symbols, blue working states and green completed
states. The main opportunities are reducing effort in large agent lists, making
files easier to open, and keeping secondary technical information out of the way.

This was an inspection of the running interfaces, their accessibility trees and
implementation, followed by targeted fixes and regression checks. It is not a
formal accessibility certification or a study with external participants.

## Initial audit coverage

| Area | Inspection and outcome |
| --- | --- |
| First connection | Native QR-first onboarding and optional SSH form; hosted web setup, pairing form, remember-browser explanation and malformed-code error. Instructions explain the computer requirement, though the web form is below a lengthy setup guide. |
| Agents and Inbox | Native real-server list and web waiting/working/done fixtures. Status is conveyed with text as well as color. Web has search and desktop sidebar navigation; native lacks equivalent search. |
| Spaces and creation | Native space chooser and Claude/Codex permission forms inspected without starting agents in user workspaces. Web space/agent dialogs checked down to 320px. The earlier real-server creation tests remain separate evidence. |
| Conversations | Native real conversation Read/Screen navigation; web reader, terminal controls and attachment dialog. Current iOS header controls were readable under light system appearance. Local artifact links in native messages can remain literal Markdown. |
| Settings and computers | Native computer chooser, connection settings and notification/terminal settings; web settings and installation guidance. The native screen repeats computer information and exposes relay terminology before most people need it. |
| Recovery and feedback | Malformed web pairing input gives a specific corrective message. Earlier real-server checks cover interrupted sends/uploads, offline recovery and revoked access; they were not repeated as production writes during this visual audit. |
| Responsive layout | Web creation forms checked at 320×568, 390×844, 768×1024 and 1440×900. No page-wide horizontal overflow in those checks. Desktop conversation retains its left agent list; phone layouts use bottom navigation. |
| Keyboard and accessibility | Inspected accessible names, modal focus and focus return, shortcut targets, reduced motion and native accessibility text size. No physical VoiceOver/TalkBack certification is claimed. |

Native inspection used the iPhone 18 Pro simulator on iOS 27 with the real saved
computer connection. Writes and error scenarios on the web used an isolated
fixture service. Private native screenshots remain local and are not included
in the repository. The scope is the applications, not a new marketing-page audit.

## Fixed during this audit

| Finding | Change | Verification |
| --- | --- | --- |
| Native agent titles could disappear at accessibility text sizes because workspace/status metadata consumed the row width. | Above a font scale of 1.4, titles get their own line with up to two lines of text, followed by metadata. At ordinary sizes metadata is bounded so the title retains space. | Rebuilt and installed the signed Release app. Inspected the real agent list at `accessibility-extra-large` and at the original text size. |
| Web bottom sheets lacked a visible close control; dismissal depended on the backdrop or Escape. | Added a labeled 44×44 close button inside the sheet heading. The decorative backdrop is excluded from the accessibility tree. | Opened/closed the space form at 320px, checked keyboard focus remains in the dialog and returns to its opener. |
| Web terminal shortcuts exposed symbols such as arrows and `^C` as accessible names. | Added names such as “Up arrow” and “Interrupt (Control C)”. | Inspected the resulting accessibility tree in Screen mode. |
| Reader shortcut buttons were 40px high. | Raised shortcut targets to at least 44×44 without changing their terminal commands. | Built the app and ran keyboard, composer, screen and dialog regression tests. |

## Follow-up findings

These were the seven remaining findings at the end of the initial audit. Their
implementation and verification are recorded below; this table preserves the
original observations and acceptance checks.

| Priority | Finding | Recommended acceptance check |
| --- | --- | --- |
| High | Changing the simulator's text size while the app was already open clipped labels across the header, filters and rows until relaunch. Relaunch corrected measurement; the title-width problem above was separate and is fixed. | Reproduce through real iOS Accessibility Settings, make the active layout remeasure without losing navigation/drafts, and verify the largest supported sizes across every primary screen. |
| High | Native messages containing Markdown links to local files can display the raw path and Markdown syntax. A real PDF artifact link showed this; the current Markdown parser recognizes HTTP(S) links only. | Render supported computer-file links as labeled actions through the existing authenticated file flow. Explain unsupported formats and unavailable files without exposing a wall of path text. |
| Medium | Native has no search equivalent to the web. A long real agent list takes substantial scrolling to find a conversation. | Search by conversation, space and folder; preserve filters and reading position when returning. Provide an explicit no-results state. |
| Medium | Settings repeats the computer switcher, computer-management row and connection card. Relay terminology and addresses add reading effort. | Lead with computer name and connection status; put transport/address details in an expandable connection-details section. Keep access management easy to find. |
| Medium | Provider filters are inconsistent: Claude/Codex are icon-only while other providers can include text. On native, the difference becomes especially pronounced at large text sizes. | Use a consistent provider-filter treatment, with full accessible names and a discoverable label for unfamiliar symbols. Preserve large tap targets. |
| Medium | The highest-permission native mode looks like other options until selected. Its explanation is useful, but its consequence is easy to overlook while scanning. | Keep a visible caution cue and clear consequence text even when unselected; test understanding with someone unfamiliar with “sandbox”. |
| Low | Web setup commands have no adjacent copy control, and the pairing form is below the setup guide. An “Already have a code?” link mitigates the latter. | Add independently labeled copy controls with confirmation; make the returning-user route prominent without hiding first-time setup. |

## Follow-up fixes

All seven findings above now have implementation fixes:

| Finding | Resolution | Evidence |
| --- | --- | --- |
| Live text resizing | Shared native text hosts remeasure when Dynamic Type changes, without remounting screens, inputs or navigation. Offline recovery content now scrolls at large text sizes. | Live simulator resize on the real agent list; a live conversation resize retained its unsent draft, and regression coverage preserves the mounted screen and input. |
| Computer-file links | Native Markdown renders absolute and home-relative file links as labeled actions through the authenticated file viewer. Unavailable files and unsupported formats have readable messages. | A real report link opened the viewer; its 3.4 MiB response exposed a relay size refusal. After correction, the rebuilt simulator app passed the same real-server flow and displayed the explicit size explanation. Local-path, spaces, line-anchor, unsafe-scheme, oversized response and unsupported PDF tests cover the remaining cases. PDF rendering is not included. |
| Native search | Search matches conversation, space, folder and provider; existing filters still apply. Added clear and no-results states. | Real-server simulator navigation retains the query after opening and returning from a conversation; no-results/clear checks and filter regression tests pass. |
| Settings repetition | One computer summary leads with name/status; transport, address and version expand on demand. Computer management remains in the same group. | Simulator expansion/collapse and unit checks. Expanded details are included in the spoken label. |
| Provider filters | Unselected providers use their symbols consistently; the selected provider also shows its name. Full accessible names remain available, with tooltips on web. | Native and web regression checks; large-text simulator inspection. |
| Highest permission | A caution border and “No approval before changes” remain visible when the option is unselected in both clients. | Native permission and browser creation regression checks. |
| Browser setup | Each command has a separate labeled copy button, success/failure feedback and a prominent returning-user shortcut that scrolls to and focuses the pairing input. | Clipboard success/denial and keyboard-focus checks in Chromium and WebKit. |

## Visual and interaction checks

- Shared palette contrast, calculated against the raised surface: main text
  15.21:1, muted text 6.76:1, amber 8.12:1, working blue 8.44:1, success green
  7.26:1 and error orange 5.10:1. These are token-level measurements, not a claim
  about every blended, disabled or translucent control.
- Web decorative avatar animations reported `none` under emulated reduced
  motion. Native avatar/logo components honor their reduced-motion setting in
  code; the physical-device experience remains a manual check.
- Main web buttons, filters, inputs and navigation targets inspected on the
  phone layout met the app's 44px target-height convention. The smaller shortcut
  controls found during inspection were corrected.
- Native default text size and light/dark system appearance were inspected.
  Shahi retains its intentional dark palette; a separate light app theme was
  not added. The original simulator appearance and text size were restored.
- Long-reader restoration, Latest, send retries, partial uploads and connection
  recovery have real-server evidence in the [customer-journey report](customer-journeys-2026-09-18.md)
  and [earlier end-to-end report](e2e-2026-09-18.md).

## Validation and limits

The initial audit passed 83 focused Chromium/WebKit browser checks, 69 web unit
tests and 317 mobile tests. After the follow-up fixes, 48 hosted-browser checks,
47 dashboard/parity/keyboard checks, 69 web unit tests and 324 mobile tests passed. Type checks, web/hosted builds and a signed iOS 27
simulator Release build passed. The rebuilt native app was installed and the
large-text correction inspected. Documentation/diff checks passed.

Physical touch ergonomics, VoiceOver traversal, Switch Control, real camera and
dictation, notification delivery, and installed Safari behavior still require
the [device checklist](verify-on-device.md). No frame-rate profiling or formal
accessibility conformance claim is made. These edits have not been deployed to
production or uploaded to TestFlight.
