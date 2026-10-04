# Parser fixtures

Real terminal screens captured from a live herdr session with
`pane.read {source: "visible"}`, one pair per agent status:

| file | what it exercises |
|---|---|
| `blocked__w4-p2__*` | a Claude Code plan-approval prompt — 4 numbered options, #1 selected |
| `blocked__trust-folder__*` | Claude Code's folder-trust question — an *unnumbered* cursor menu, 2 options, the second selected, `Enter to confirm` under it |
| `blocked__wK-p2__*`, `blocked__wE-p6__*` | further blocked shapes |
| `blocked__claude-bash__*`, `blocked__claude-bash-rm__*` | Claude Code's Bash permission dialog: the command sits *above* a generic "Do you want to proceed?"; two commands, identical answers |
| `blocked__claude-webfetch__*`, `blocked__claude-mcp__*` | the same dialog for WebFetch (the URL above the question) and an MCP tool call |
| `blocked__claude-webfetch-no__*` | WebFetch with the cursor on "No, and tell Claude what to do differently" — typing there does nothing, so typed text would be lost |
| `blocked__claude-ask-type__*`, `blocked__claude-plan-change__*` | the cursor on a row that takes text ("Type something.", "Tell Claude what to change") — typed text replaces the row's label and Enter submits it |
| `blocked__claude-ask-typed__*`, `blocked__claude-ask-typed-away__*` | the question tool's text row after a `1` was typed into it ("❯ 3. 1"), with the cursor on it and then moved to row 2 — the label is the typed text, so the row is known by its place (Claude Code 2.1.282, 2026-09-25) |
| `working__wE-p1__*` | an agent mid-turn, no prompt |
| `idle__w4-p1__*` | an idle agent at the composer |
| `done__wB-p1__*` | a finished turn |

`__text.txt` is `strip_ansi: true`, `__ansi.txt` is the raw escape-sequence
form, `__meta.json` is the matching `AgentInfo`.

## These have been sanitised — keep them that way

They came from real working sessions, which is what makes them good fixtures:
the parser is driven by screens herdr actually produced rather than ones we
imagined. That also meant they carried real content, and a pre-publication
audit found personal data (a name, an email, a booking) and a third party's
project detail in them.

What was done, and the rule for anyone adding more:

- Five fixtures no test referenced were **deleted** rather than cleaned. An
  unreferenced capture is not worth the review it costs.
- The rest were scrubbed with **equal-length replacements**, because
  `prompt-parser.test.ts` asserts that the `__ansi` and `__text` halves parse
  identically and that `stripAnsi(ansi)` normalises to `text`. A substitution
  that changes a line's width breaks column alignment and the cursor row, and
  the parser depends on both. Change a name to one of the same length, or
  recapture.
- Home directories read `/home/operator`. Keep it that way.

**Before adding a capture, read it.** Whatever was on that screen is what you
are committing — file paths, task descriptions, whatever the agent was told.

Note that scrubbing a file here does not remove it from git history; anything
already committed stays until the history is rewritten.

To recapture against your own session:

```sh
bun run server/scripts/capture-fixtures.ts
```

The `blocked__claude-*` captures (Claude Code 2.1.280, herdr 0.9.1,
2026-09-23) were made differently, because a permission dialog has to be
provoked rather than waited for: an isolated named herdr session with a fresh
`XDG_CONFIG_HOME` (see CLAUDE.md, Testing), `claude --permission-mode default`
in a scratch folder under that root, a one-line request for a harmless tool
call, `pane.read` of the visible screen, then Escape. The MCP dialog came from a
one-tool stdio server passed with `--strict-mcp-config --mcp-config`. The
account's plan name in the welcome banner was replaced with `[redacted]`, the
same length.

## `startup/`

Screens an agent draws outside its conversation, captured from Claude Code
2.1.286 and codex 0.157.1 under herdr 0.9.1 (October 2026) with
`pane.read {source: "visible", format: "ansi"}`, in a scratch named herdr
session with scratch agent configuration and fake keys: nothing personal is
in them. The fake key's `sk-ant-api03-` prefix was replaced with the
equal-length `sk-fake-key--`, so no scanner takes it for a key.
`claude-failed-start` is a stand-in `claude` printing 2.1.286's
minimum-version words. The `codex-0.130-*`, `codex-0.150-*` and
`claude-2.1.2xx-*` screens came from those releases installed with npm in a
disposable OrbStack machine under herdr 0.9.3; its shell prompt's user was
replaced at equal length with `testuser`. `docs/agent-screens.md` lists every screen, and
`server/scripts/screen-census.ts` draws them again on a newer agent and
compares them with these.

The `codex-0.160-migration` capture comes from the official 0.160.0 binary,
verified against the SHA-256 checked release archive on October 4, 2026,
under checksum-verified herdr 0.9.3. Unlike the older migration menu, this
screen only offers Enter/Esc to continue or Ctrl+C to quit. The old menu
fixture stays covered; the new notice is held to screen-with-keys behavior.
`codex-0.160-update` uses the same verified binary cloned into a scratch
standalone layout, with a synthetic latest-version record of 9.0.0 to draw
the update offer offline. No update choice was selected.
These two captures normalize line endings and trailing empty terminal rows;
their text, ANSI color spans and menu alignment are retained.

## Codex 0.160 question panels

The `blocked__codex-user-input-0.160-*__text.txt` files were captured on
4 October 2026 with checksum-verified herdr 0.9.3 and official Codex 0.160.0
in an isolated named session. A loopback Responses fixture supplied synthetic
questions, so no paid model request or owner's conversation was read. Default
and Plan both advanced with a single digit. Tab opened notes; Enter submitted
notes with the selected choice. The Other choice's digit submitted at once.

Only the question panel was extracted from each real screen, unchanged apart
from dropping trailing empty terminal rows. Shell, account and scratch-path
chrome is outside these tracked fixtures. The notes captures cover the empty
field, typed notes, Other selection and an existing draft with appended text.
