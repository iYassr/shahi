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
