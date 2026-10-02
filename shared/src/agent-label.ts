/** CLI identifiers stay on the wire; people see the product's name. */
const labels: Record<string, string> = {
  claude: "Claude", codex: "Codex", cursor: "Cursor", agy: "Antigravity",
  pi: "Pi", gemini: "Gemini", devin: "Devin", cline: "Cline",
  omp: "Oh My Pi", mastracode: "Mastra Code", opencode: "OpenCode",
  copilot: "GitHub Copilot", kimi: "Kimi", kiro: "Kiro", droid: "Droid",
  amp: "Amp", grok: "Grok", hermes: "Hermes", kilo: "Kilo",
  qodercli: "Qoder", qwen: "Qwen", letta: "Letta", maki: "Maki", muse: "Muse",
};
export function agentLabel(kind: string): string {
  return labels[kind.toLowerCase()] ?? kind;
}

/**
 * The program herdr runs for an agent kind: the kind's own name, except
 * Cursor, whose `cursor` kind launches `cursor-agent` (`cursor` opens the
 * editor). Discovery looks for it, and a title that is only this command line
 * is not a conversation's name (`paneTitle`).
 */
export function agentCommand(kind: string): string {
  return kind === "cursor" ? "cursor-agent" : kind;
}

/**
 * Which agent a New agent form starts on: the one this person last started on
 * this computer, else Claude where it is installed, else the first. The form
 * used to start on whichever installed kind sorted first, so a computer with
 * Antigravity offered it to everyone (simulator run of build 32, October
 * 2026).
 */
export function defaultAgentKind(kinds: readonly string[], last: string | null | undefined): string | null {
  if (last && kinds.includes(last)) return last;
  if (kinds.includes("claude")) return "claude";
  return kinds[0] ?? null;
}
