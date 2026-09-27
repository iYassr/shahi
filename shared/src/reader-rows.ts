import type { LogBlock, LogMessage } from "./index";

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
      append({ ...first, showHeader: true });
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
