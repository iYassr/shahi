# Reader provider audit — 27 September 2026

This extends [the live provider checks](provider-modes-2026-09-27.md) with
structured Reader coverage for all five agents available on this Mac. herdr can
recognize additional agent types; a display label or launch manifest alone does
not establish Reader support. Those providers retain Screen mode.

## Coverage

| Provider | Transcript and ownership | Reader coverage and limits |
| --- | --- | --- |
| Claude Code | Exact reported session UUID under the canonical projects root | Existing messages, thinking, tools, results, questions, images and supported system notes. Duplicate distinct files and escaping symlinks are refused. The account's usage limit still prevents a fresh successful live work check; earlier quota messages render. |
| Codex 0.157.1 | Exact reported session via its SQLite rollout index, or one foreground process with one open rollout | Existing legacy/current event families, commands, edits, questions, reasoning, MCP, web and image activity. Final-file symlink escapes and ambiguous fallback files/processes are refused. Audio playback and unknown extension shapes remain unavailable. |
| Cursor 2026.09.26-dd393fe | Exact UUID JSONL export or the pane process's open session database | Authored text, recorded tool calls, failure/cancellation notes and attachment labels. The exporter omits result bodies, call IDs and timestamps, and merges reasoning into prose. No data is invented from those omissions. |
| Antigravity 1.2.11 | Reported UUID or unique process-owned presence lock, then documented brain transcript | User text, response, thinking, tool calls, recorded singular-call results, file links, errors, questions and truncation notes. Internal context is omitted. No verified image-attachment shape was available. |
| OpenCode 1.18.32 | Reported `ses_` ID in its read-only SQLite message/part projection | Text, thinking, pending/completed/failed tools, edits, command/MCP output, questions, files, recorded inline images, compaction/retry/error notes and undo/branch changes. Synthetic context and unknown parts are omitted. |

## Findings fixed

- Added explicit provider dispatch. Unknown agents can no longer use their UUID
  to fall through to Claude's transcript or image reader. Cached pages and
  summaries include their provider identity.
- Cursor's writer rewrites its JSONL in place and drops prior end-of-turn notes.
  Its Reader verifies the complete indexed prefix after a file change and gives
  rewritten history a new path boundary. Appends retain that boundary. If its
  file index is evicted, a fresh pagination read also invalidates cached tail
  pages, allowing existing clients to recover on their next poll.
- Antigravity uses the same rewrite boundary for `/rewind`. A truncated list of
  tool calls cannot establish that a surviving single call owned the next result,
  so those rows show output as unavailable rather than attributing it by guess.
- OpenCode database and WAL changes invalidate pages, dashboard summaries and
  live Reader watches even when the database's size stays constant. Queries
  use bounded windows and read-only transactions. No migrations or checkpoints
  run against the provider database.
- OpenCode pagination counts only rendered messages. Synthetic-only, malformed
  and internal records cannot strand Load earlier behind an empty page. SQLite
  visibility checks and bounded projections agree on hidden fields, Unicode
  whitespace and invalid NUL values; truncated metadata cannot manufacture a
  different local file link.
- OpenCode undo changes the existing transcript path identity. Durable removal
  event sequences also distinguish a pruned branch when undo and the next prompt
  happen between polls. Existing API 5 clients therefore discard removed loaded
  history without a new native binary.
- New provider adapters bound prose, tool fields, question lists, attachment
  metadata and message size. Images have separate authenticated, session-scoped
  references; pages contain no image bytes, and the server never fetches remote
  attachment URLs.
- Claude, Codex and Cursor require canonical ownership and reject ambiguous
  transcript copies. Antigravity presence locks identify the active conversation;
  open database handles can include previous or child conversations and do not.

## Live evidence

OpenCode used an isolated named herdr session, disposable files, and private
provider configuration. A real read/write/command task produced the expected
file and recorded results. A new session's first prompt selected its own
transcript without the old marker. A separate resumed pane reported the same
exact ID after its integration initialized. Undo and redo changed the visible
message count from seven to two and back to seven. A pruned branch produced
durable removal events; the Reader uses those events in its path identity.

Antigravity ran a read/edit/command task, then concurrent fresh and resumed
processes in the same folder. Each resolved its own presence lock and transcript.
The resumed session retained the original results; the fresh session contained
only its distinct marker. Combining both descriptor lists correctly returned
no unambiguous session. Test processes were stopped after verification.

Cursor's installed exporter and writer were inspected directly. A previously
created disposable failed session now exposes its recorded failure note. Claude
and Codex ownership findings were reproduced in isolated filesystem/process
fixtures before applying the fixes.

## Remaining boundaries

- OpenCode's installed and current herdr TUI integrations retain the last session
  at the empty home screen. The next first prompt reports the new ID. Shahi does
  not infer a different session from terminal prose.
- OpenCode uses the sidecar's configured `XDG_DATA_HOME` / `OPENCODE_DB`, with
  the standard database as default. A different override only in an agent's
  environment is not discovered by recency or working folder. Old schemas
  without durable event history remain unavailable instead of merging stale
  removed messages.
- Cursor's export cannot provide raw omitted tool results or inline attachment
  bytes. Antigravity multi-call rows lack result IDs; only the measured immediate
  singular-call pairing is supported. Its images remain unsupported.
- This is a server Reader release. It uses the current API 5 contract and works
  with the existing TestFlight app. New native rendering behavior and another
  physical-device recording are not part of this change.

The provider schemas were checked against [OpenCode's pinned source](https://github.com/anomalyco/opencode/tree/545f51d26cc39a907d2867492d498d9607ea5fa4)
and [Antigravity's official transcript documentation](https://antigravity.google/docs/hooks/),
alongside the installed CLIs and disposable live sessions.

## Verification

- Workspace type checking and web production build passed.
- Native suite: 561 passed, one skipped across 60 suites.
- Relay suite: 118 passed.
- Browser Reader suite: 25 passed in Chromium and WebKit, including both new
  providers, expanded tools, thinking, questions and retained scrolling/history.

The release gate also requires canonical unit/dependency checks and the full
CI matrix before publishing, including browser/hosted/PWA suites, real herdr
versions, and packaged upgrade/recovery on four platforms.
