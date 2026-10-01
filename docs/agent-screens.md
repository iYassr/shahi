# Agent screens

What Claude Code and codex draw outside a conversation (sign-in, terms, trust,
updates, model changes, approvals), and what Shahi does with each. Read from
Claude Code 2.1.286's bundled source and codex's source at `rust-v0.158.0`,
with the startup screens captured live on this Mac under herdr 0.9.1 (October
2026). The captures are the fixtures in `server/fixtures/startup/`.

## The rule

A message Shahi refuses always comes with something to answer instead:

- **A recognised menu** gets a card. The buttons show whatever herdr says,
  except while herdr says the agent is working. herdr reports most startup
  screens `idle`, and the message guard has always refused a message behind
  any recognised menu, so waiting for `blocked` left the phone with a refusal
  and no buttons (`Poller.#asks`).
- **A wait Shahi cannot read** gets the screen itself, with keys
  (`PaneFrame.unrecognised`, `shared/src/screen-card.ts`). That is herdr
  saying `blocked` over a screen the parsers do not know, and the measured
  waits that offer nothing to choose. A message there is refused with 409
  `prompt_unrecognised`: Claude Code's unnumbered menus move on `j`/`k` in
  typed text, and Enter takes whatever row is lit.
- **A new agent with no conversation yet** shows its screen in Read, so its
  startup screens are visible even where they are neither.
- **An agent that exits while starting** is quoted in the error, for example
  an outdated Claude Code's "needs an update … claude update".

Answers press Enter only once a fresh read shows the chosen row lit (see
CLAUDE.md, "A prompt is answered by the server").

`server/lib/agent-screens.test.ts` holds every captured screen to this, as
herdr `idle`, `unknown` and `blocked`.

## Claude Code, before the prompt

In order. Since 2.1.248 the safety dialogs are unnumbered, start on their
refusing row, and ignore digits. A key within 150ms of a dialog opening is
refused and the cursor goes back to that row.

| Screen | When | herdr | Shahi | Esc |
|---|---|---|---|---|
| Theme picker | first run | idle | card (named parser) | nothing |
| Login method | first run, signed out | idle | card | — |
| Paste code / Press Enter to continue | during sign-in | — | message typed / screen card | — |
| Security notes | first run | — | screen card (Enter) | — |
| Terminal setup | Apple Terminal, VS Code, … (not seen under herdr) | — | card | skips |
| Folder trust ("Accessing workspace:") | untrusted folder | unknown → blocked | card | **quits** |
| New MCP server (one) | project `.mcp.json` | unknown → blocked | card, titled | rejects, saved |
| New MCP servers (several) | project `.mcp.json` | idle | screen card | rejects all, saved |
| External CLAUDE.md imports | imports outside the folder | blocked | card | declines, saved |
| Consumer Terms update | claude.ai plans, server-driven | not captured | card (numbered) | **quits** outside the grace period |
| Use this API key? | `ANTHROPIC_API_KEY` new | blocked | card | declines, saved |
| Bypass permissions warning | Full access mode, first time | unknown → blocked | card, titled | **quits** |
| Settings Error / Warning | invalid settings file | unknown → idle → blocked | card, titled | Error **quits** |
| Minimum version | Claude Code too old | — (exits) | start fails, quoting it | — |

Claude Code has no "update?" menu: updates are footer notices, and a version
below the minimum prints "needs an update … claude update" and exits.

## Claude Code, mid-session

Permission prompts (Bash, file edits, MCP tools, WebFetch, skills), plan mode,
questions and MCP input requests are the cards Shahi already answers; herdr
reports them `blocked`. Others: the usage-limit menu, cost warning, effort and
auto-mode suggestions, fullscreen offer, resume prompts, LSP and plugin
recommendations (these clear themselves after 30 s). Any of them the parsers
miss while herdr says `blocked` gets the screen card.

The feedback survey ("How is Claude doing this session? 1: Bad 2: Fine 3: Good
0: Dismiss") keeps the prompt focused and takes a message that is exactly one
digit as its rating. It is shown at a rate of 0.005 per turn and can be turned
off with `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1`; Shahi does not set it.

## Codex, before the composer

Drawn at the top of an otherwise empty terminal, cleared on exit, and all
reported `idle` by herdr 0.9.1.

| Screen | When | Shahi | Keys |
|---|---|---|---|
| Update available | newer release, standalone/npm/brew install | card (named parser) | digits act at once; bare Enter updates |
| Welcome / sign in | not signed in | card | digits act at once; Esc does nothing |
| Folder access (trust) | untrusted folder | card (named parser) | `1` only highlights; `2`, `q`, Esc quit |
| Hooks need review | a hook new or changed, including herdr's own after `herdr integration install codex` | card (named parser) | `2` only highlights; Esc skips |
| Model migration | retired or superseded model | card (named parser) | digits act at once; **Esc accepts** |
| Model notice, nothing to choose | same, old model gone | screen card | Enter or Esc continue |

Hooks review follows every `herdr integration install codex`, which Shahi runs
itself. Continuing without trusting leaves herdr's hook off, and Reader then
finds codex's transcript by its open file instead of the reported session.

Mid-session, codex's approvals, MCP forms and questions are numbered menus
the generic parser reads; its asynchronous questions do not block the
composer.

## Checking a new version

```sh
bun run server/scripts/screen-census.ts            # every situation
bun run server/scripts/screen-census.ts codex-hooks claude-trust
```

It draws each screen above that can be reproduced offline in a scratch named
herdr session with scratch agent configuration and fake keys, and compares
each card with its fixture. A difference exits 1 and names the screen; update
the fixture and its parser together. The update offer, the Consumer Terms and
the mid-session menus cannot be drawn this way.

## Deliberately not done

Shahi does not pre-answer these screens with launch flags or configuration.
Trust, terms, hook trust, model changes and API keys are the person's
decisions, and most of the settings that skip them are undocumented.
