# Live provider and permission checks — 27 September 2026

This extends [the creation and Reader audit](agent-compatibility-2026-09-27.md)
with actual agent work through Shahi's semantic HTTP routes. Each conversation
used disposable files in a separate workspace of an isolated named herdr 0.9.1
session. The test server had a fresh configuration root, private authentication,
no relay, and WebSocket watches. Production panes were not used for test writes.
No dependency versions were changed. No provider update command was run; the
installed CLIs did advance their own versions during the session.

## Results

Claude Code reported 2.1.283 and Codex 0.157.1. Initial discovery reported Cursor
2026.09.02-c22c1a3, Antigravity 1.2.5 and OpenCode 1.18.31; final installed-command
checks reported Cursor 2026.09.26-dd393fe, Antigravity 1.2.11 and OpenCode 1.18.32.
Running processes and self-updated launchers need not have the same version, so
this is a check of the live installed providers, not a pinned-version matrix.

| Provider / Shahi mode | Real work and permission evidence | Reader |
| --- | --- | --- |
| Codex / Ask me | Read the unique fixture; denied an edit with no file created; approved an edit and a command that wrote a marker | Correct text and tool activity |
| Codex / Agent decides | Read, edit and command inside workspace; rejected a write outside the workspace, then allowed a separate request | Correct text and tool activity |
| Codex / Full auto | Read, edit and command without approval; attempted outside write failed, no file created | Passed after fixing shared-daemon attachment |
| Codex / Skip sandbox and prompts | Read, edit, command and explicit outside-fixture write without approval | Passed after fixing shared-daemon attachment |
| Claude / all four modes | Launch and folder trust worked; live task attempts returned the account's weekly usage limit | The quota reply renders; successful work remains unverified |
| Cursor / provider default | Read, edit, approve command once, reject a writing command and submit denial feedback; rejected output absent | Exact session text and tool activity render |
| Antigravity / provider default | Read; reject and approve an edit; reject and approve a command; rejected operations left files untouched | No structured adapter; Screen only |
| OpenCode / provider default | Read, edit and command run under its permissive defaults | No structured adapter; Screen only |
| OpenCode / fixture-local ask policy | Rejected an edit with no file created; allowed an edit once and a command once | Screen only |

Cursor, Antigravity and OpenCode currently have no Shahi permission-mode picker.
Their rows test provider defaults and the stated local policy, not every native
CLI mode. OpenCode's fixture-local `opencode.json` asked for `edit` and `bash`;
no global provider policy was changed. Its approved edit inserted an extra blank
line: permission delivery succeeded, but that response did not meet the prompt's
exact one-newline requirement. This is not a claim of model-output correctness.

## Reproduced defects and fixes

1. **Cursor discovery checked the editor launcher.** It now checks `cursor-agent`,
   the executable herdr's Cursor kind actually starts. All five installed providers
   appeared in the real `/api/agents` result after the fix.
2. **Codex folder trust disappeared above empty screen padding.** The parser now
   trims trailing blank rows and recognises the current warning and Enter footer.
   Typed messages at fresh trust screens returned `409 prompt_open`; explicit
   answers selected the intended row.
3. **Current Cursor and Antigravity menus lacked cards.** Exact trust, command and
   edit shapes now receive buttons even when herdr reports idle/done. The card
   keeps the folder, command or diff context. Cursor batch approval context is
   retained; Skip opens a typed feedback field. The typed replacement is checked
   against the unchanged screen before Enter. Wrapped/multiline feedback stays
   conservative and can require Enter from the key bar.
4. **OpenCode's horizontal approval was invisible to the numbered-menu parser.**
   The parser keeps ANSI and finds the uniquely highlighted option by relative
   background colour. Answers walk left/right from the fresh selection, rather
   than assuming Allow once is selected. Unknown colour shapes remain unparsed.
5. **Codex Full auto/bypass attached to the shared daemon.** Its foreground TUI had
   no rollout file open and no usable herdr session binding. Both asking modes
   already passed an explicit reviewer override and used an embedded server.
   All four modes now select the user reviewer explicitly. Fresh Full auto and
   bypass sessions then exposed their exact session and passed Reader, edit,
   command, and sandbox-boundary checks. No working-folder or newest-file lookup
   was added. This behavior is explained by the installed version's
   [daemon launch policy](https://github.com/openai/codex/blob/3665039/codex-rs/tui/src/daemon_startup.rs).

The answer route still re-reads the screen, verifies question/context/option and
prompt instance, and serialises writes. Older API 5 clients send the same choice
payload and need no native update. New `answer` variants affect only how the
server calculates keys; clients already omit meaningless numeric labels for
non-numbered choices.

## Automated verification

- Type checking across all workspaces passed.
- Canonical unit run: 1,329 passed, 29 skipped; four dependency regression checks passed.
- Native suite: 557 passed, one skipped across 60 suites.
- Browser creation/approval suites: 143 passed across Chromium and WebKit.
- Web production build passed.
- Additional release/version policy checks passed after the version bump.

New regression coverage includes wrong/missing cursors, malformed trust options,
missing provider chrome, moved questions, fresh horizontal selections, alternate
highlight colours, legacy answer payloads, blocking typed text, waiting dashboard
state, and the Cursor feedback field changing after typing.

Release CI also exposed intermittent TestFlight-dialog test failures in Linux
WebKit. A diagnostic run recorded the page scrolling between mouse-down and
mouse-up, delivering the click to a surrounding section instead of the opener.
The phone cases now use the existing touch helper; desktop cases still click.
Dialog, focus, validation and small-screen assertions remain intact.

These checks do not substitute for successful Claude tasks after quota resets,
physical-device push/reconnect testing, or structured Antigravity/OpenCode Reader
support. OpenCode's default policy is documented by its
[permission reference](https://opencode.ai/docs/permissions/); an unprompted default
write was not misclassified as a sandbox escape.
