import type { BackgroundNotice, LogBlock, LogMessage, ReaderTask, SessionLog } from "./index";

export type ActivityStep = { id: string; at: number; block: Extract<LogBlock, { kind: "tool" | "thinking" }> };
export interface ReaderActivity {
  steps: ActivityStep[];
  files: { path: string; name: string }[];
  images: string[];
}
export interface ReaderRow extends LogMessage {
  showHeader: boolean;
  activity?: ReaderActivity;
}

/**
 * API records are not chat bubbles. Keep prose as individually anchored rows,
 * but collect routine work between user/system messages beneath the response.
 * Questions and failed steps remain visible. No provider-specific prose is
 * guessed to be a final answer, a command, or an instruction to the person.
 */
export function readerRows(messages: LogMessage[], previous: ReaderRow[] = []): ReaderRow[] {
  const rows: ReaderRow[] = [];
  // A client holds a contiguous tail of the transcript, so every subagent call
  // it holds has its later notices too. The last one wins: a resumed agent
  // reports again under the same call.
  const notices = new Map<string, { text: string; notice: BackgroundNotice }>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.kind === "text" && block.notice?.toolUseId) notices.set(block.notice.toolUseId, { text: block.text, notice: block.notice });
    }
  }
  const called = new Set(messages.flatMap(message => message.blocks.flatMap(block => block.kind === "tool" && block.subagent ? [block.subagent.id] : [])));
  const old = new Map(previous.map(row => [row.id, row]));
  const activityIds = new Map(previous.flatMap(row => row.activity?.steps.map(step => [step.id, row.id] as const) ?? []));
  const append = (row: ReaderRow) => {
    const before = old.get(row.id);
    const same = before && before.role === row.role && before.at === row.at && before.showHeader === row.showHeader
      && before.blocks.length === row.blocks.length && before.blocks.every((block, i) => block === row.blocks[i])
      && (!before.activity && !row.activity || before.activity && row.activity
        && before.activity.steps.length === row.activity.steps.length
        && before.activity.steps.every((step, i) => {
          const next = row.activity!.steps[i]!;
          return step.id === next.id && step.at === next.at && step.block === next.block;
        }));
    rows.push(same ? before : row);
  };

  for (let start = 0; start < messages.length;) {
    const first = messages[start]!;
    if (first.role !== "agent") {
      // A report folded into the row of the subagent it reports on is not
      // said again on its own; one about anything else stays a note.
      const kept = first.blocks.filter(block => !(block.kind === "text" && block.notice?.toolUseId && called.has(block.notice.toolUseId)));
      if (kept.length) append(kept.length === first.blocks.length ? { ...first, showHeader: true } : { ...first, blocks: kept, showHeader: true });
      start++;
      continue;
    }
    let end = start;
    let header = true;
    const steps: ActivityStep[] = [];
    const files = new Map<string, { path: string; name: string }>();
    const images = new Set<string>();
    while (end < messages.length && messages[end]!.role === "agent") {
      const message = messages[end++]!;
      const blocks: LogBlock[] = [];
      message.blocks.forEach((block, index) => {
        if (block.kind === "tool" && block.subagent) {
          // A subagent is work the person asked for, often for minutes, and
          // was buried in the collapsed activity as one more tool call.
          blocks.push(subagentView(block, block.subagent.id ? notices.get(block.subagent.id) : undefined));
          return;
        }
        if (block.kind === "thinking" || block.kind === "tool" && !block.questions?.length && !block.result?.isError) {
          steps.push({ id: JSON.stringify([message.id, index]), at: message.at, block });
          if (block.kind === "tool") {
            if (block.file) files.set(block.file.path, block.file);
            block.result?.images.forEach(ref => images.add(ref));
          }
        } else {
          blocks.push(block);
        }
      });
      if (blocks.length) {
        append({ ...message, blocks, showHeader: header });
        header = false;
      }
    }
    if (steps.length) {
      // Preserve an existing disclosure while a tail grows or earlier history
      // is loaded. Prose always keeps its original message id for scroll anchors.
      const id = steps.map(step => activityIds.get(step.id)).find(Boolean) ?? `activity:${steps[0]!.id}`;
      append({ id, role: "agent", at: 0, blocks: [], showHeader: false,
        activity: { steps, files: [...files.values()], images: [...images] } });
    }
    start = end;
  }
  return rows.length === previous.length && rows.every((row, i) => row === previous[i]) ? previous : rows;
}

/** Name only measured tool families; unknown/MCP tools keep a neutral status. */
export function readerActivityLabel(activity: ReaderActivity, working: boolean): string {
  let label = "Activity";
  if (working) {
    const last = activity.steps.at(-1)?.block;
    label = "Working…";
    if (last?.kind === "thinking") label = "Thinking…";
    if (last?.kind === "tool" && !last.result && !last.outputUnavailable) {
      const name = last.name.toLowerCase();
      if (["read", "read_file", "view_file"].includes(name)) label = "Reading files…";
      else if (["bash", "exec", "exec_command", "run_command", "shell"].includes(name)) label = "Running a command…";
      else if (["edit", "write", "write_file", "apply_patch", "replace_file_content"].includes(name)) label = "Updating files…";
      else if (["grep", "glob", "search", "web_search"].includes(name)) label = "Searching…";
    }
  }
  return `${label} · ${activity.steps.length} ${activity.steps.length === 1 ? "step" : "steps"}`;
}

type ToolBlock = Extract<LogBlock, { kind: "tool" }>;
const views = new WeakMap<ToolBlock, { notice: string | undefined; view: ToolBlock }>();

/**
 * The subagent call with its state and report filled in: from its notice when
 * it ran in the background, from its own result otherwise. The same object
 * while neither changes, so unchanged rows are reused (see `append`).
 */
function subagentView(block: ToolBlock, notice: { text: string; notice: BackgroundNotice } | undefined): ToolBlock {
  const key = notice ? `${notice.notice.status}\n${notice.text}` : undefined;
  const held = views.get(block);
  if (held && held.notice === key) return held.view;
  const call = block.subagent!;
  let state: NonNullable<typeof call.state> = "running";
  let report: string | undefined;
  if (call.background) {
    if (notice) {
      state = notice.notice.status === "completed" ? "done" : notice.notice.status === "killed" ? "stopped" : "failed";
      // The note's first line is its headline ("Agent … finished (completed)").
      report = notice.text.split("\n").slice(1).join("\n").trim() || undefined;
    }
  } else if (block.result) {
    state = block.result.isError ? "failed" : "done";
    report = block.result.text.trim() || undefined;
  }
  const view: ToolBlock = { ...block, subagent: { ...call, state, ...(report ? { report } : {}) } };
  views.set(block, { notice: key, view });
  return view;
}

/** A task list and how far along it is, as Claude Code heads its own: "5 tasks (4 done, 1 in progress, 0 open)". */
export interface ReaderTaskList {
  tasks: ReaderTask[];
  done: number;
  inProgress: number;
  open: number;
}

/**
 * The conversation's task list: the server's copy of the agent's own store
 * when it sent one, which holds every task whatever page is loaded; otherwise
 * the latest `TodoWrite` among the loaded messages, which carries its whole
 * list in each call. Null when there is neither, or nothing in it.
 */
export function readerTasks(log: Pick<SessionLog, "tasks"> | null | undefined, messages: LogMessage[]): ReaderTaskList | null {
  let tasks = log?.tasks;
  if (!tasks) {
    for (let m = messages.length - 1; m >= 0 && !tasks; m--) {
      const blocks = messages[m]!.blocks;
      for (let b = blocks.length - 1; b >= 0; b--) {
        const block = blocks[b]!;
        if (block.kind === "tool" && block.todos) {
          tasks = block.todos.map((todo, i) => ({ id: String(i + 1), subject: todo.content, status: todo.status }));
          break;
        }
      }
    }
  }
  if (!tasks?.length) return null;
  const count = (status: ReaderTask["status"]) => tasks!.filter(task => task.status === status).length;
  return { tasks, done: count("completed"), inProgress: count("in_progress"), open: count("pending") };
}

/** "5 tasks (4 done, 1 in progress, 0 open)". */
export function readerTasksLabel(list: ReaderTaskList): string {
  return `${list.tasks.length} ${list.tasks.length === 1 ? "task" : "tasks"} (${list.done} done, ${list.inProgress} in progress, ${list.open} open)`;
}
