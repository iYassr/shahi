# Customer journey verification — 18 September 2026

Tested the iOS 27 simulator app and desktop/phone-width web app against two separate Shahi instances on the actual Ubuntu server. Both used fresh herdr configuration directories and named sessions. Agent processes, file writes, device grants and Cloudflare relay traffic were real. Test messages went only to dedicated test panes.

This extends the [earlier end-to-end checks](e2e-2026-09-18.md) and [file-transfer boundary tests](upload-verification-2026-09-18.md).

## Real customer scenarios

| Journey | Evidence and outcome |
| --- | --- |
| Connect a second computer | Native and web paired both computers through the encrypted relay while preserving the original connection. |
| Paste a malformed or previously used code | Web rejects malformed input. Native and web explain that a used code needs replacing, rather than retrying forever. The optional native SSH form remains accessible and cannot submit empty credentials. |
| Move between computers with unfinished messages | Both computers deliberately used the same pane identifier. Native and web kept drafts separate; returning to each restored its own text. |
| Leave and return to a conversation | Native and web preserved drafts. Native also preserved its draft through a genuine background/resume cycle. |
| Type the next message before the previous receipt arrives | With relay replies delayed, the web retained the newer text instead of clearing it with the previous message. A Unicode message reached the real server intact. |
| Lose connectivity after sending but before confirmation | The shell executed the command once. After reconnecting, retrying the uncertain send reused its operation identifier; the server file still contained exactly one line. |
| Send the same operation concurrently | On each server, four concurrent message requests produced one shell write, and three concurrent creation requests produced one new pane. |
| Upload a batch across an interruption | After the first file completed, the connection was cut. The web retained that attachment, offered to retry the remaining two, and finished with three distinct attachments. |
| Upload many files simultaneously | Sixteen uploads per server all eventually succeeded. Expected busy responses supplied retry guidance; filenames and bytes were checked, including traversal-like filenames and duplicate names. |
| Change orientation and reopen offline | Phone portrait and landscape layouts had no horizontal overflow and retained the draft. The PWA shell opened offline and restored the remembered conversation after reconnecting. Chrome reported no installability errors. |
| Restart the computer-side service | Native recovered its real space list. Web reconnected without pairing again and preserved an unsent draft throughout a separate stop/start check. |
| Create an agent using a normal readable name | A native Codex opened automatically. A web Cursor named “Customer cursor second review” opened its actual conversation and composer. Real immediate workspace → tab → agent creation/read requests also passed without sleeps. |
| Revoke a connected device | Native immediately returned to the computer chooser. Web left the conversation and remained unpaired after reload. The original native computer stayed usable. |
| Open a closed pane | The real server returned 404. Regression tests distinguish this from connection errors and a newly created pane whose session update arrives late. |

Network faults were injected in a local forwarding bridge; it preserved encrypted frame order and forwarded to the actual Cloudflare relay. These were not fabricated server responses. The Mac's direct network route to Cloudflare was not tested.

## Fixes found by these journeys

- Preserve bounded, memory-only drafts and attachment state separately for each computer and pane; retain uncertain send identifiers across navigation and clear state on sign-out/revocation.
- Prevent duplicate send taps and late receipts from erasing newer edits. Ignore stale completions after leaving a screen.
- Retain completed batch attachments and offer retry for only the remaining files.
- Prevent late reader responses from the previous computer from restoring its cached content. Allow deliberate keyboard/file-button scrolling instead of fighting it during reader restoration.
- Stop retrying a refused one-time pairing code and explain how to reconnect.
- Convert readable agent labels into valid internal names, including spaces, accents, non-Latin text and numeric prefixes, while retaining the display label.
- Refresh the server's session view after creating a workspace, tab or agent before returning success. Await any older snapshot before obtaining the post-creation snapshot. Web also recovers when a late session update confirms a previously missing pane, for compatibility with older servers.

## Automated regression evidence

These use controlled fixtures or unit-level inputs and are additional evidence, separate from the real-server journeys above.

| Check | Result |
| --- | --- |
| Full unit command, including signup and operations | 688 passed; 26 opt-in cases skipped |
| Dependency checks | 4 passed |
| Mobile | 317 passed across 39 suites |
| Relay | 68 passed |
| Main browser suite, Chromium and WebKit | 192 passed; 1 existing skip |
| Hosted encrypted-client suite, Chromium and WebKit | 44 passed |
| PWA cache/update suite | 11 passed; 1 existing WebKit offline-emulation skip |
| Final type checks, web and hosted builds, whitespace checks | Passed |
| Signed iOS 27 simulator Release build | Built, installed and exercised |

The final creation fixes additionally passed focused server, web and native regressions. The broad browser suite preceded that last fix; the hosted/PWA suites and real creation retest followed it.

## Limits

Drafts survive navigation, switching computers and background/resume while the app process remains alive. They are deliberately not persisted across a browser reload or native process termination. Operation retry protection is process-local; these tests do not establish exactly-once execution across a server crash.

The relay upload limit remains **761 KiB per file**, and SSH uploads support **32 MiB**; see the linked boundary report. Large relay uploads are rejected, not chunked.

Physical iPhone camera scanning, push delivery, dictation, actual Safari installation and successful native SSH authentication remain outside this run. Provider quota/authentication restrictions described in the earlier report still apply. The current run verifies real startup and transport behavior, not successful AI work from every provider under every permission mode.

No production release or TestFlight upload was performed by this test run.

## Cleanup

Native and browser test grants were revoked. The simulator was returned to its original computer. Both isolated servers and named sessions were stopped, and their source, state, uploads and temporary credentials were removed. The customer-test tunnel and fault bridge were stopped; the existing simulator relay bridge remains available. Production still has its original socket and herdr process, with 22 workspaces and 106 panes. Agent tools can retain their own test conversation records in their normal data directories.
