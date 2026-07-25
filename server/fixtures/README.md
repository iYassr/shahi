# Parser fixtures

Real terminal screens captured from a live herdr session with
`pane.read {source: "visible"}`, one pair per agent status:

| file | what it exercises |
|---|---|
| `blocked__w4-p2__*` | a Claude Code plan-approval prompt — 4 numbered options, #1 selected |
| `working__wE-p1__*` | an agent mid-turn, no prompt |
| `idle__w4-p1__*`, `idle__w4-p7__*` | idle agents at the composer |
| `done__w4-p8__*`, `done__wB-p1__*` | finished turns |

`__text.txt` is `strip_ansi: true`, `__ansi.txt` is the raw escape-sequence
form, `__meta.json` is the matching `AgentInfo`.

## ⚠️ These contain real terminal content

They were captured from actual working sessions, so they include real project
names, file paths, and task descriptions. That is exactly what makes them good
parser fixtures — but **sanitise them before making this repository public.**

To recapture against your own session:

```sh
bun run server/scripts/capture-fixtures.ts
```
