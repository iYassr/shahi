# Read against Screen, 1 October 2026

The owner put Read and Screen of one conversation side by side on the phone
and saw three things Reader had never shown: the newest reply (Read showed one
from hours before), Claude Code's task list, and its subagents. All three were
in files on the computer the whole time. This report says why testing missed
them, what now checks for that kind of miss, and what the checks found on their
first run.

## Why testing missed them

- **Tests compared Reader with expectations its authors wrote.** Unit tests feed
  rows we wrote or captured, the browser suite reads a stub's invented
  transcripts, and device passes checked the feature being changed. Nothing
  compared Reader with what the agent itself drew, which is the only ground
  truth a person has.
- **The September census asked the wrong question.** It read 1,029 Claude
  transcripts and 70 Codex rollouts and asked, of each record shape, whether
  Reader could display it. A `TaskCreate` call can be displayed, as one step in
  Activity, so it counted as covered. The task list Claude Code draws comes from
  many calls and a separate store. The census treated records one at a time,
  but what the person sees is often state built across records and files.
- **Dropping was silent.** "Unknown shapes are dropped, never guessed" is the
  right rule for display, and nothing counted what it dropped.
  `docs/testing-strategy.md` §F asked for that count; it was never built.
  `continued-in` rows were in local transcripts from 1 September.
- **Source was read for one question only.** Codex publishes its conversation
  items (`TurnItem`); Claude Code's repository holds documentation, not its
  implementation, and its installed bundle was read for dialogs, not for what
  it writes.

## What now checks

| Check | Run | Fails when |
|---|---|---|
| `server/lib/transcript-shapes.ts` and its test | every push (`bun run test`) | a decision disagrees with what the readers do with that shape |
| `bun run server/scripts/transcript-census.ts --source` | before a release, after an agent updates | any record, block, attachment, tool or Codex item on this computer, or in the installed Codex release's source, has no decision |
| `bun run server/scripts/reader-parity.ts` | before a release, while an agent works through a multi-step task | Screen's newest prose, its task list, or most of its prose is not in Read |
| `docs/verify-on-device.md` check 23 | each release candidate on the phone | Read and Screen of the same conversation disagree |

The census and the parity check read the owner's own transcripts and screens,
so they run on the owner's computer, read-only, printing shape names, pane ids
and counts.

## What the first runs found

Census of 38 main Claude transcripts (2.1.286) and 101 Codex rollouts (0.157.1),
plus Codex 0.157.1's 19 `TurnItem` variants:

- **Messages typed while Claude was working.** Claude Code delivers them
  mid-turn as `attachment` rows (`queued_command`, `commandMode: "prompt"`).
  125 of 128 such messages existed only there; Reader dropped all of them.
  They are now the person's messages. Background reports delivered the same
  way are notices, including a monitor's events, which carry no status (10 of
  125) and had been attributed to the person when written as user rows.
- 71 other shapes were classified. Each has a stated reason.

Parity check across 14 live agent panes (11 Claude, 3 Codex) on herdr 0.9.1:

- **A pane read another pane's conversation.** Backgrounding a Claude
  conversation parks it as a job run by Claude's daemon; the pane keeps showing
  the job, and the process record names it (`parkedJobId`, then
  `jobs/<id>/state.json`). The job reports its session through herdr's hook
  with the daemon's `HERDR_PANE_ID`, which is that of the pane that first
  started the daemon. So wJ:p1 was reported as running a job parked from w3:p1,
  and its Read showed that conversation. Every line on its Screen was in the
  job it had parked. The process record agreed with Screen in all eleven Claude
  panes, the hook in ten. Reader now follows a parked job before herdr's
  report.
- After both fixes, Read agrees with Screen in every agent pane. With each of
  the three original bugs put back, the check flags the pane: 6/14 lines for
  the wrong conversation; 0/12 lines and 0/5 tasks without following the
  continuation; 0/5 tasks without the task list.

## Known limits

- A background report waiting in Claude's queue (`queue-operation`, `enqueue`)
  is drawn on Screen before it is delivered. Most queued reports are removed
  without delivery (1,313 of 1,594), so Reader shows a report only once
  delivered. The parity check therefore needs two of the three newest lines to
  be missing before it reports a pane.
- Screen previews what a tool wrote or ran; Reader keeps a step to one line and
  opens files in the viewer. The check compares prose and the person's
  messages, not tool steps.
- Only Claude Code's and Codex's screen shapes are known to the check. Other
  agents are listed but not compared.
- Codex's subagent items (`SubAgentActivity`, `CollabAgentToolCall`) stay
  dropped: the subagent's calls (`spawn_agent`, `wait`) are already steps.
  Whether Codex's screen draws subagents as more than those steps has not been
  compared on a live subagent.
