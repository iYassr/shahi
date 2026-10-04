/**
 * Every shape an agent writes to the transcripts Reader reads, and what
 * Reader does with it.
 *
 * "Unknown shapes are dropped, never guessed" kept Reader from inventing
 * things, but it was silent: Claude Code's task list, its subagents, its
 * `continued-in` handoff and every message typed while Claude was working
 * were all in the local transcripts during the September 2026 census, and all
 * missing from Reader until the owner compared Read with Screen. The census
 * asked whether each record could be displayed; a TaskCreate call could (as one
 * more step in Activity), so it counted as covered, though what Claude Code
 * draws from those calls is a checklist that outlives them.
 *
 * So every key below is a decision, and `server/scripts/transcript-census.ts`
 * fails on any key an agent writes that is not here. Adding one means
 * answering what the person sees on Screen when the agent writes it:
 *
 *   - shown: Reader renders it.
 *   - state: Claude draws something that outlives the record (a task list, a
 *     running subagent), and Reader shows that state, not only the record.
 *   - followed: it changes which transcript Reader reads.
 *   - dropped: nobody sees it as conversation; `why` says what it is instead.
 */
export type Handling = "shown" | "state" | "followed" | "dropped";
export interface Decision { handling: Handling; why: string }

const shown = (why: string): Decision => ({ handling: "shown", why });
const state = (why: string): Decision => ({ handling: "state", why });
const dropped = (why: string): Decision => ({ handling: "dropped", why });

const BOOKKEEPING = "session bookkeeping, never drawn in the conversation";
const MODEL_CONTEXT = "context Claude Code adds for the model, not drawn as conversation";

/** Claude Code main transcripts, `<config>/projects/<project>/<session>.jsonl`; measured on 2.1.286. */
export const CLAUDE_SHAPES: Record<string, Decision> = {
  "record:user": shown("the person's messages, and tool results joined to their calls"),
  "record:assistant": shown("Claude's replies, thinking and tool calls"),
  "record:system": shown("by subtype, below"),
  "record:attachment": shown("by attachment type, below"),
  "record:continued-in": { handling: "followed", why: "a backgrounded session continues in another transcript (continuedTranscript)" },
  "record:agent-name": dropped("the session's name; the list titles panes from herdr"),
  "record:ai-title": dropped("the session's generated title; the list titles panes from herdr"),
  "record:custom-title": dropped("a /rename title; the list titles panes from herdr"),
  "record:artifact-autoreact-ledger": dropped(BOOKKEEPING),
  "record:artifact-comment-monitor": dropped(BOOKKEEPING),
  "record:atis-latch": dropped(BOOKKEEPING),
  "record:bridge-session": dropped(BOOKKEEPING),
  "record:cost-state": dropped(BOOKKEEPING),
  "record:file-history-delta": dropped("checkpoint data for /rewind"),
  "record:file-history-snapshot": dropped("checkpoint data for /rewind"),
  "record:frame-link": dropped(BOOKKEEPING),
  "record:last-prompt": dropped("a copy of the last prompt, already shown as its own message"),
  "record:mode": dropped("the composer's mode, drawn in the footer, not the conversation"),
  "record:permission-mode": dropped("the permission mode, drawn in the footer, not the conversation"),
  "record:pr-link": dropped("a pull request link drawn in the footer, not the conversation"),
  "record:queue-operation": dropped("messages waiting under the composer; each is shown once delivered, as a user row or a queued_command"),
  "record:summary": dropped("an older session's title row"),

  "system:away_summary": shown("Claude recounting what it did while the person was away"),
  "system:model_refusal_fallback": shown("explains a model switch the person saw"),
  "system:compact_boundary": dropped("marks where /compact cut the context"),
  "system:informational": dropped("transient notices such as Backgrounding…"),
  "system:local_command": dropped("a local command's echo; its output arrives as <local-command-stdout>"),
  "system:turn_duration": dropped("the turn's timing"),

  "attachment:queued_command": shown("a message typed while Claude was working, delivered mid-turn, or a background task's report"),
  "queued:prompt": shown("the person's message, as they typed it"),
  "queued:task-notification": shown("a background task's report, folded into its subagent row"),
  "attachment:agent_listing_delta": dropped(MODEL_CONTEXT),
  "attachment:auto_mode": dropped(MODEL_CONTEXT),
  "attachment:bash_output_audience_note": dropped(MODEL_CONTEXT),
  "attachment:batching_reminder_sent": dropped(MODEL_CONTEXT),
  "attachment:command_permissions": dropped(MODEL_CONTEXT),
  "attachment:compact_file_reference": dropped(MODEL_CONTEXT),
  "attachment:credential_org": dropped(MODEL_CONTEXT),
  "attachment:date": dropped(MODEL_CONTEXT),
  "attachment:date_change": dropped(MODEL_CONTEXT),
  "attachment:deferred_tools_delta": dropped(MODEL_CONTEXT),
  "attachment:deferred_tools_record": dropped(MODEL_CONTEXT),
  "attachment:diagnostics": dropped("editor diagnostics passed to the model"),
  "attachment:edited_text_file": dropped("a file the person edited, passed to the model"),
  "attachment:environment": dropped(MODEL_CONTEXT),
  "attachment:file": dropped("an @-mentioned file's contents; the mention itself is in the person's message"),
  "attachment:hook_system_message": dropped("a hook's message to the model"),
  "attachment:instructions": dropped(MODEL_CONTEXT),
  "attachment:invoked_skills": dropped("skill instructions loaded for the model"),
  "attachment:mcp_instructions_delta": dropped(MODEL_CONTEXT),
  "attachment:model": dropped(MODEL_CONTEXT),
  "attachment:nested_memory": dropped("CLAUDE.md files loaded for the model"),
  "attachment:plan_mode": dropped("plan-mode instructions for the model"),
  "attachment:plan_mode_exit": dropped("plan-mode instructions for the model"),
  "attachment:prompt_snapshot": dropped(MODEL_CONTEXT),
  "attachment:read_truncation_notice": dropped(MODEL_CONTEXT),
  "attachment:remote_session_change": dropped(MODEL_CONTEXT),
  "attachment:session_context": dropped(MODEL_CONTEXT),
  "attachment:silent_turn_reminder": dropped(MODEL_CONTEXT),
  "attachment:skill_listing": dropped(MODEL_CONTEXT),
  "attachment:task_reminder": dropped("the model's copy of the task list, which Reader reads from the store"),
  "attachment:task_status": dropped("the model's copy of a background task's progress; its subagent row shows the state"),
  "attachment:thinking_drop": dropped(MODEL_CONTEXT),
  "attachment:total_tokens_reminder": dropped(MODEL_CONTEXT),
  "attachment:ultra_effort_enter": dropped(MODEL_CONTEXT),
  "attachment:ultra_effort_exit": dropped(MODEL_CONTEXT),

  "block:assistant.text": shown("Claude's prose"),
  "block:assistant.thinking": shown("Claude's thinking, in Activity"),
  "block:assistant.redacted_thinking": dropped("encrypted thinking with no readable text"),
  "block:assistant.tool_use": shown("each call by tool name, below"),
  "block:assistant.fallback": shown("a model switch, as a note"),
  "block:user.text": shown("the person's words"),
  "block:user.image": shown("an image the person attached"),
  "block:user.tool_result": shown("joined to its call"),
  "result:text": shown("tool output"),
  "result:image": shown("an image a tool returned"),
  "result:tool_reference": dropped("ToolSearch's list of loaded tools"),

  // Tools. A plain call is one step in Activity, which is what Claude Code
  // draws for it too. `state` marks the ones whose effect stays on Screen.
  "tool:TaskCreate": state("Claude's task checklist, read from <config>/tasks"),
  "tool:TaskUpdate": state("Claude's task checklist, read from <config>/tasks"),
  "tool:TaskList": state("Claude's task checklist, read from <config>/tasks"),
  "tool:TaskGet": state("Claude's task checklist, read from <config>/tasks"),
  "tool:TodoWrite": state("the older task checklist, from the latest call"),
  "tool:Agent": state("a subagent, its own row with its status and report"),
  "tool:Task": state("a subagent under its older name"),
  "tool:AskUserQuestion": state("a question card while unanswered, the answer after"),
  "tool:ExitPlanMode": shown("the plan, then an approval prompt on the card"),
  "tool:EnterPlanMode": shown("a step"),
  "tool:Bash": shown("a step"),
  "tool:BashOutput": shown("a step"),
  "tool:KillShell": shown("a step"),
  "tool:Monitor": shown("a step; its reports arrive as notices"),
  "tool:Edit": shown("a step with its file"),
  "tool:MultiEdit": shown("a step with its file"),
  "tool:Write": shown("a step with its file"),
  "tool:Read": shown("a step with its file"),
  "tool:NotebookEdit": shown("a step with its file"),
  "tool:Glob": shown("a step"),
  "tool:Grep": shown("a step"),
  "tool:WebFetch": shown("a step"),
  "tool:WebSearch": shown("a step"),
  "tool:Skill": shown("a step"),
  "tool:SlashCommand": shown("a step"),
  "tool:ToolSearch": shown("a step"),
  "tool:TaskStop": shown("a step"),
  "tool:SendMessage": shown("a step"),
  "tool:ListAgents": shown("a step"),
  "tool:SubagentHandback": shown("a step"),
  "tool:Workflow": shown("a step"),
  "tool:StructuredOutput": shown("a step"),
  "tool:Artifact": shown("a step"),
  "tool:PushNotification": shown("a step"),
  "tool:SendUserFile": shown("a step with its file"),
  "tool:SendFeedback": shown("a step"),
  "tool:mcp__*": shown("an MCP call, a step"),
};

/** Codex rollouts, `<CODEX_HOME>/sessions/…/rollout-*.jsonl`; measured on 0.157.1. */
export const CODEX_SHAPES: Record<string, Decision> = {
  "record:session_meta": dropped(BOOKKEEPING),
  "record:turn_context": dropped(BOOKKEEPING),
  "record:token_usage_record": dropped(BOOKKEEPING),
  "record:world_state": dropped(BOOKKEEPING),
  "record:inter_agent_communication_metadata": dropped(BOOKKEEPING),
  "record:realtime_item": dropped("voice-session audio items"),
  "record:compacted": dropped("the summary written after compaction"),
  "record:event_msg": shown("by event type, below"),
  "record:response_item": shown("tool calls and their output, by type below"),

  "event:item_completed": shown("by item type, below"),
  "event:user_message": shown("older rollouts' messages"),
  "event:agent_message": shown("older rollouts' messages"),
  "event:agent_reasoning": shown("older rollouts' reasoning"),
  "event:agent_reasoning_raw_content": shown("older rollouts' reasoning"),
  "event:mcp_tool_call_end": shown("older rollouts' MCP calls"),
  "event:patch_apply_end": shown("older rollouts' edits"),
  "event:web_search_end": shown("older rollouts' searches"),
  "event:token_count": dropped(BOOKKEEPING),
  "event:task_started": dropped("turn boundaries"),
  "event:task_complete": dropped("turn boundaries"),
  "event:turn_aborted": dropped("turn boundaries"),
  "event:thread_settings_applied": dropped(BOOKKEEPING),

  "item:UserMessage": shown("the person's messages"),
  "item:AgentMessage": shown("Codex's replies"),
  "item:Reasoning": shown("reasoning, in Activity"),
  "item:Plan": shown("the plan"),
  "item:CommandExecution": shown("a command and its output"),
  "item:FunctionCallOutput": shown("a tool's output"),
  "item:DynamicToolCall": shown("a step"),
  "item:McpToolCall": shown("an MCP call"),
  "item:FileChange": shown("an edit"),
  "item:WebSearch": shown("a search"),
  "item:ImageView": shown("an image Codex looked at"),
  "item:ImageGeneration": shown("a generated image"),
  "item:Extension": shown("search, image generation and sleep"),
  "item:EnteredReviewMode": shown("a review starting"),
  "item:ExitedReviewMode": shown("a review's findings"),
  "item:ContextCompaction": shown("a compaction note"),
  "item:HookPrompt": dropped("context a hook injected for the model"),
  "item:CollabAgentToolCall": dropped("a subagent call's status; the call itself is a spawn_agent/wait step"),
  "item:SubAgentActivity": dropped("a subagent starting or finishing; shown as its spawn_agent and wait steps"),

  "response:message": dropped("raw model input and output, including developer prompts; items carry the conversation"),
  "response:reasoning": dropped("raw reasoning; the Reasoning item carries it"),
  "response:agent_message": dropped("raw output; the AgentMessage item carries it"),
  "response:function_call": shown("tools in Activity; request_user_input questions stay visible with their descriptions"),
  "response:custom_tool_call": shown("a step"),
  "response:function_call_output": shown("joined to its call"),
  "response:custom_tool_call_output": shown("joined to its call"),
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The keys one Claude transcript row contributes, in the table's terms. */
export function claudeShapes(row: unknown): string[] {
  if (!isRecord(row)) return [];
  const keys = [`record:${String(row.type)}`];
  if (row.type === "system") keys.push(`system:${String(row.subtype)}`);
  if (row.type === "attachment" && isRecord(row.attachment)) {
    keys.push(`attachment:${String(row.attachment.type)}`);
    if (row.attachment.type === "queued_command") keys.push(`queued:${String(row.attachment.commandMode)}`);
  }
  const content = isRecord(row.message) ? row.message.content : undefined;
  if (Array.isArray(content)) for (const block of content) {
    if (!isRecord(block)) continue;
    keys.push(`block:${String(row.type)}.${String(block.type)}`);
    if (block.type === "tool_use") keys.push(`tool:${String(block.name).startsWith("mcp__") ? "mcp__*" : String(block.name)}`);
    if (block.type === "tool_result" && Array.isArray(block.content)) {
      for (const part of block.content) if (isRecord(part)) keys.push(`result:${String(part.type)}`);
    }
  }
  return keys;
}

/** The keys one Codex rollout row contributes. Tool names are not classified: every call is one step. */
export function codexShapes(row: unknown): string[] {
  if (!isRecord(row)) return [];
  const keys = [`record:${String(row.type)}`];
  const payload = isRecord(row.payload) ? row.payload : {};
  if (row.type === "event_msg") {
    keys.push(`event:${String(payload.type)}`);
    if (payload.type === "item_completed" && isRecord(payload.item)) keys.push(`item:${String(payload.item.type)}`);
  }
  if (row.type === "response_item") keys.push(`response:${String(payload.type)}`);
  return keys;
}

/** Keys seen that no decision covers, most frequent first. */
export function unclassified(counts: Map<string, number>, table: Record<string, Decision>): [string, number][] {
  return [...counts].filter(([key]) => !(key in table)).sort((a, b) => b[1] - a[1]);
}
