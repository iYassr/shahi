# Claude and Codex audit — 27 September 2026

This report records the checks completed before preparing computer release 0.3.9
and the next TestFlight build. It is verification evidence, not confirmation of
distribution. Reader and launch fixes live in the computer service; ordering
also needs the updated shared code in each client.

## Sources and scope

- Installed Claude Code **2.1.283** and Codex **0.157.1**, with herdr **0.9.1**.
- Codex's [0.157.1 protocol items](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/protocol/src/items.rs),
  [extension items](https://github.com/openai/codex/tree/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/ext/items),
  user-input schema, rollout retention policy and approval configuration.
- The [Claude Code repository](https://github.com/anthropics/claude-code)
  provides documentation, plugins and a changelog, rather than the complete
  CLI implementation. Its [permission documentation](https://code.claude.com/docs/en/permissions)
  and [CLI reference](https://code.claude.com/docs/en/cli-reference), installed
  help and actual transcript shapes supplied the comparison.
- A read-only shape census covered 1,029 Claude transcript files, including
  subagents, and 70 Codex rollouts. Only counts and field shapes were retained
  for the audit; private conversation content is not included in fixtures or reports.

## Findings fixed

**New conversations sorted last.** Ordering used only the last message date,
which a new session does not have. The computer now persists the time it first
observes a new conversation. Both clients sort by the later of that start and
the last message, with pinned conversations first. Focus, status changes and
reconnection do not bump it. The first startup snapshot does not invent dates
for existing sessions. Migration from the previous database preserves unknown
dates, and a restored conversation keeps its recorded start.

**Permission defaults could drift.** A missing mode previously inherited the
provider default; it now explicitly selects Ask me for known providers. Invalid
mode ids fail before creating a tab. Codex's asking modes now set
`approvals_reviewer="user"`, so a saved automatic reviewer cannot take over
prompts advertised as asking the user. Claude descriptions now acknowledge saved
allow rules, permitted file commands and remaining bypass confirmations.

**Current Codex UI items were missing from Reader.** The adapter now retains
question-only agent messages, plans, structured command results and failures,
standalone function/dynamic-tool results, MCP errors, reviews, compaction notes,
image views and generation, plus web-search/image-generation/sleep extensions.
Structured commands remain beside their outer exec wrapper because the observed
IDs cannot reliably join them. Existing raw collaboration calls remain visible;
injected hook prompts, raw model context and unknown records remain excluded.

**Codex images were absent.** User, generated, MCP and dynamic/function-result
inline images now use the existing authenticated image endpoint. Reader pages
carry references, not base64 payloads. References include the exact rollout so
an old image cannot be fetched from the next session in the same pane. Local
image paths use the authenticated file viewer. Remote URLs are not fetched,
script-bearing media types are refused, and malformed image data returns no image.

**Two transcript identity details were wrong.** Reusing a pane id with a new
terminal now invalidates its cached transcript location immediately. A Claude
assistant message whose content is a plain string is labeled as the agent,
rather than as a system note.

## Permission-mode verification

All eight modes launched in separate disposable panes, with matching actual
process arguments and detected provider. These checks establish launch and flag
selection, not every possible command's approval behavior.

| Provider | Offered mode | Effective selection |
| --- | --- | --- |
| Claude | Ask me | `--permission-mode manual` |
| Claude | Auto-accept edits | `--permission-mode acceptEdits` |
| Claude | Plan first | `--permission-mode plan` |
| Claude | Skip all permissions | `--dangerously-skip-permissions` |
| Codex | Ask me | read-only sandbox, on-request approval, user reviewer |
| Codex | Agent decides | workspace-write sandbox, on-request approval, user reviewer |
| Codex | Full auto | workspace-write sandbox, never approval |
| Codex | Skip sandbox and prompts | `--dangerously-bypass-approvals-and-sandbox` |

## Verification

- Canonical unit suite: **1,304 passed**, 29 opt-in checks skipped;
  dependency checks: **4 passed**.
- Native component suite: **558 passed** across 60 suites.
- Mode creation, Read/Screen, prompt targeting and returning to the newly
  created top row: **32 browser cases plus sign-in**, across Chromium and WebKit.
- Reader/dashboard regression: **38 browser cases plus sign-in**, across both engines.
- Isolated live herdr adapter suite: **23 passed**, two optional checks skipped.
- All project type checks and the web production build passed.
- Browser-harness visual check at 390 px: inline image loaded, plan and
  question options readable, command output expanded, no horizontal overflow.
- Codex completed a real synthetic reply and Reader found both user and agent
  messages. Two further fresh sessions passed immediate first-message delivery
  through Shahi's prompt path. One earlier direct-herdr probe timed out without
  a transcript; that outcome was not counted as a successful round trip.
- Claude accepted the synthetic message and its exact transcript included the
  provider's rate-limit response. A successful model reply was **not** verified.

All live writes targeted an isolated named herdr session under a fresh
`XDG_CONFIG_HOME`. Existing work was untouched. Disposable workspaces and the
test server were stopped after verification. Provider tools may keep the synthetic
conversations in their normal histories.

## Remaining limits

- Inline audio is identified as an attachment, but Reader has no audio player.
  Local audio paths can be opened through the file viewer.
- Opaque web-search result metadata is not rendered as authored text. Unknown
  future schema shapes are omitted until checked against their provider.
- This run did not repeat physical-iPhone QA or the full deployment/recovery
  release matrix. The existing physical checklist and remaining boundaries in
  [the review completion report](review-completion-2026-09-26.md#remaining-boundaries)
  still apply. Successful paid-provider work under every mode is not established.
- Publish an approved computer release and an updated phone build before claiming
  these fixes are present in the installed product. The current App Store
  submission was not withdrawn or replaced by this audit.
