/** Public display records from Codex 0.157.1's protocol/items and ext/items.
 * These are completed UI items, never raw model/developer context. */
import { fileURLToPath } from "node:url";
import { fileOf, isRecord, stringOr, type Block, type LogMessage } from "./session-log";
import { codexDataImage } from "./codex-media";

type Tool = Block & { kind: "tool" };
type Display = Pick<LogMessage, "role" | "blocks">;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const result = (text: string, isError = false): NonNullable<Tool["result"]> => ({
  text: text.slice(0, 2_000).replace(/[\uD800-\uDBFF]$/, ""), isError, truncated: text.length > 2_000, images: [],
});
const tool = (name: string, summary: string, text?: string, failed = false): Tool => ({
  kind: "tool", name, summary, result: text === undefined ? null : result(text, failed),
  ...(text === undefined ? { outputUnavailable: true } : {}),
});

/** Paths remain authenticated file-viewer requests; URI schemes never become links. */
function localFile(value: unknown): ReturnType<typeof fileOf> {
  if (typeof value !== "string") return {};
  if (value.startsWith("file:")) {
    try { value = fileURLToPath(value); } catch { return {}; }
  }
  return fileOf({ path: value });
}

/** Never ship base64 media from a rollout in a reader response. */
export function codexInputAttachments(content: unknown[]): Block[] {
  return content.flatMap((part): Block[] => {
    if (!isRecord(part)) return [];
    switch (part.type) {
      case "local_image":
      case "local_audio":
        return [{ ...tool("Attachment", part.type === "local_image" ? "Image" : "Audio"), ...localFile(part.path) }];
      case "image": return codexDataImage(part.image_url) ? [] : [tool("Attachment", "Image attached; preview is unavailable in Reader")];
      case "audio": return [tool("Attachment", "Audio attached; playback is unavailable in Reader")];
      case "skill":
      case "mention":
        return typeof part.name === "string" ? [{ kind: "text", text: `${part.type === "skill" ? "Skill" : "Mention"}: ${part.name}` }] : [];
      default: return [];
    }
  });
}

export function codexQuestions(item: Record<string, unknown>): Tool[] {
  const questions = (Array.isArray(item.questions) ? item.questions : []).filter(isRecord)
    .filter(q => typeof q.title === "string" && q.title.trim())
    .map(q => ({ text: q.title as string, options: strings(q.options).map(label => ({ label })) }));
  return questions.length ? [{ kind: "tool", name: "Question", summary: questions[0]!.text, questions, result: null }] : [];
}

export function codexDisplayItem(item: Record<string, unknown>): Display | null {
  const agent = (...blocks: Block[]): Display => ({ role: "agent", blocks });
  switch (item.type) {
    case "Plan":
      return typeof item.text === "string" && item.text.trim() ? agent({ kind: "text", text: item.text }) : null;
    case "CommandExecution": {
      const command = strings(item.command);
      const summary = command.length >= 3 && /^-(?:l?c|cl)$/.test(command[1]!) ? command.slice(2).join(" ") : command.join(" ");
      const output = typeof item.aggregated_output === "string" ? item.aggregated_output
        : [item.stdout, item.stderr].filter((v): v is string => typeof v === "string" && v.length > 0).join("\n");
      const failed = item.status === "failed" || item.status === "declined" || typeof item.exit_code === "number" && item.exit_code !== 0;
      return agent(tool("command", summary, output || (typeof item.exit_code === "number" ? `Exit code: ${item.exit_code}` : stringOr(item.status, "Output not retained")), failed));
    }
    case "ImageView":
      return agent({ ...tool("view_image", "Viewed image", "Image opened"), ...localFile(item.path) });
    case "FunctionCallOutput": {
      const output = typeof item.output === "string" ? item.output : Array.isArray(item.output)
        ? item.output.filter(isRecord).map(p => stringOr(p.text, "")).filter(Boolean).join("\n") : "";
      return agent(tool(stringOr(item.name, "tool"), "Tool response", output || undefined));
    }
    case "DynamicToolCall": {
      const output = (Array.isArray(item.content_items) ? item.content_items : []).filter(isRecord)
        .map(p => stringOr(p.text, "")).filter(Boolean).join("\n");
      return agent(tool(stringOr(item.tool, "tool"), "", stringOr(item.error, "") || output || undefined, item.success === false || item.status === "failed"));
    }
    case "EnteredReviewMode":
      return { role: "system", blocks: [{ kind: "text", text: `Review: ${stringOr(item.user_facing_hint, "Started code review")}` }] };
    case "ExitedReviewMode": {
      const review = isRecord(item.review_output) ? item.review_output : {};
      const findings = (Array.isArray(review.findings) ? review.findings : []).filter(isRecord)
        .map(f => [stringOr(f.title, ""), stringOr(f.body, "")].filter(Boolean).join("\n"));
      const text = [...findings, stringOr(review.overall_explanation, "")].filter(Boolean).join("\n\n");
      return text ? agent({ kind: "text", text }) : { role: "system", blocks: [{ kind: "text", text: "Code review ended" }] };
    }
    case "ContextCompaction":
      return { role: "system", blocks: [{ kind: "text", text: "Conversation context compacted" }] };
    case "ImageGeneration":
      return agent(generatedImage(item, item.saved_path, item.revised_prompt));
    case "Extension":
      switch (item.kind) {
        case "web.search": {
          const action = isRecord(item.action) ? item.action : {};
          const summary = [stringOr(item.query, ""), stringOr(action.url, ""), stringOr(action.pattern, "")].filter(Boolean).join(" · ");
          // Results are an opaque extension schema. Do not turn arbitrary
          // result metadata or inline assets into model-authored prose.
          return agent(tool("web_search", summary || "Web search"));
        }
        case "image_gen.generation": return agent(generatedImage(item, item.savedPath, item.revisedPrompt));
        case "clock.sleep":
          return typeof item.durationMs === "number" && Number.isFinite(item.durationMs) && item.durationMs >= 0
            ? agent(tool("sleep", `Waited ${item.durationMs / 1000} seconds`, "Finished waiting")) : null;
      }
  }
  // HookPrompt is injected context. Collaboration calls already have raw
  // function_call/output records; SubAgentActivity is lifecycle metadata.
  // New, unrecognised records remain omitted rather than guessed at.
  return null;
}

function generatedImage(item: Record<string, unknown>, path: unknown, prompt: unknown): Tool {
  const file = localFile(path);
  const status = stringOr(item.status, "");
  const failed = status === "failed" || isRecord(item.failure);
  return { ...tool("image_generation", stringOr(prompt, "Generated image"), failed ? "Image generation failed" : status || undefined, failed), ...file };
}
