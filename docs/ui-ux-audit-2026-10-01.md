# UI/UX audit, 1 October 2026

The native app (TestFlight 1.0.0 build 28) walked end to end on the owner's
iPhone through iPhone Mirroring, against the owner's Mac running computer
0.3.16 with four computers paired. Writes went only into conversations made
for the audit (`~/shahi-device-test`); existing conversations were read, never
typed into or closed. Screenshots stay out of the repository: they show the
owner's conversations.

Each finding says what was seen and what changed in computer 0.3.17 and
TestFlight build 29, or why it waits.

## Agents

| # | Seen | Now |
|---|---|---|
| A1 | Rows said nothing about when a conversation last moved. | Each row ends with a short age ("now", "5m", "Yesterday", "Sep 20") from the last message, or from the start before one; spoken as "last active …". Web too. |
| A2 | A new agent's preview was its full absolute folder. | "No messages yet", dimmed; shells show their folder as `~/…`. Web too. |
| A3 | Inbox: each finished conversation needed its own "Mark reviewed". | "Mark all reviewed" when more than one waits. Web too. |
| A4 | The long-press menu offered Pin and Open screen only. | Adds Mark reviewed (for unreviewed finished work) and Copy last reply (the full reply, not the 160-character preview). |
| A5 | Two new agents can both be titled "Claude Code" until their first message, and space tags truncate. | Waits: the title is the agent's own terminal title; moving the space tag to the second line is a layout change of its own. |
| A6 | The provider filter chips are icons without words. | Waits: they carry spoken labels; visible labels would crowd the row at large text. |

## A conversation

| # | Seen | Now |
|---|---|---|
| C1 | Tapping a picture did nothing; every image sat letterboxed in a fixed 220pt box. | Images are buttons that open a full-screen viewer with pinch zoom and Save / Share; the thumbnail takes the image's shape up to a cap. Images opened from a file link zoom too. Web already opened them. |
| C2 | Every message carried only its time, so last week read like this morning. | "Yesterday 2:27 PM", "Mon 2:27 PM", "Sep 12, 2:27 PM". Web too. |
| C3 | A new Claude at its folder-trust question: Read said it "started before Shahi could identify it" and offered old conversations. | Read says Claude has saved nothing yet; old conversations are offered only for a Claude that has some. |
| C4 | A message refused behind a menu showed "Delivery not confirmed". | A refusal before typing is final, and the next send is a new message. Web too. |
| C5 | The attach sheet mixed uploading from the phone with naming a file on the computer, opened the computer at home, and offered the way back as a row named "~". | "From this phone" and "From the computer", each saying what it does; opens in the agent's folder with Home and Agent's folder shortcuts; the parent row is "Up". |
| C6 | Screen: tiny at the default width; its keys had no digits for numbered menus. | 1, 2 and 3 join the keys, in both apps. The text size waits for a pinch-to-zoom terminal. |
| C7 | After returning from another app, a full "Computer disconnected" card with other computers to open, for about ten seconds, though nothing was wrong. | "Reconnecting to Mac…" on one line for seven seconds after a live link drops or the app returns, then the full card if it has not recovered. Offline, refused access, version mismatches and host-key changes show at once. Web too. |
| C8 | A refusal's banner stays after the agent has moved on. | Waits: it can be dismissed, and clearing it on a screen change risks hiding a refusal the person has not read. |

## Spaces

| # | Seen | Now |
|---|---|---|
| S1 | New space meant typing an absolute path on a phone, with chips for folders already in use. | A folder browser for the computer: Recent folders, a breadcrumb, an Up row and "Use this folder"; the typed path stays as an advanced option. |
| S2 | The name had to be typed separately. | It follows the folder's name until the person types one. |
| S3 | "+ New agent" on the Agents tab asked for a space with no way to make one. | "+ New space" at the top of the list continues straight to the agent form. |

## Computers and Settings

| # | Seen | Now |
|---|---|---|
| K1 | Each computer card had loose "Rename" and red "Revoke this phone's access" links under it, a mis-tap away. | Behind a "…" menu, with a confirmation that names the computer. |
| K2 | Cards led with the relay host and id, and said nothing about waiting agents. | Status and waiting count first, the host and id as one small line beneath. The header switcher already showed waiting counts; they now come before the address. Web's Computers page keeps its explicit buttons, which already confirm. |
| T1 | Settings mixed this computer's settings with the app's. | "This computer": status, Shahi and herdr versions, last refreshed, computers, updates and release channel, notifications and pinned conversations (both are kept per computer), devices, sign out. "This app": terminal width, diagnostics, version with build, licences, privacy and help. Web shows the computer's versions too. |
| T2 | "Last update · 74s ago" did not say what it measured; the app version had no build number; the release channel read as two links. | "Last refreshed"; the version with its build, "1.0.0 (29)"; a Stable/Beta segmented control with its explanation. |

## Not covered

Pairing a new device (it would have added one to the owner's computer),
notifications (off on this phone), dictation, accessibility text sizes, and
the web client beyond the parity items above.

## On build 29

Checked on the phone after release. Row times, "No messages yet", Mark all
reviewed, the attach sheet's sections and agent folder, the folder browser and
its breadcrumb, "+ New space" in Choose a space, the Computers menu and the
grouped Settings all behaved as described. Four things did not, and were
fixed in build 30:

- The image viewer's Done and Save / Share sat under the status bar, where a
  tap reached iOS's "◀ TestFlight" link: a modal is a native root of its own,
  and the app's safe-area provider did not reach it.
- Wide images ran past the right edge of their message: a percentage width
  with `aspectRatio` and `maxHeight` let Yoga size them from the height cap.
  Their height now comes from the measured width.
- Settings showed "1.0.0" without its build: `Constants.nativeBuildVersion` is
  empty in expo-constants 57, so it is read from expo-application.
- Thirteen recent folders filled the new-space browser; it shows five and
  "Show all". The attach sheet's folder reads `~/…`.
