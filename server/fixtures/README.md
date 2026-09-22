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
