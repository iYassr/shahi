/**
 * Vesper, shared with the web client by hand.
 *
 * Not imported from `shared/`: that package is the *wire* contract and stays
 * free of anything platform-specific. Colours are small and stable; the wire
 * types are neither, which is why only they are enforced centrally.
 */
export const theme = {
  void: "#101010",
  surface: "#161616",
  raised: "#1c1c1c",
  line: "#282828",
  lineBright: "#3a3a3a",
  dim: "#8b8b8b",
  fg: "#ffffff",
  /** Blocked — the one thing that needs you. */
  peach: "#ffc799",
  mint: "#99ffe4",
  rose: "#ff8080",
  mono: "Menlo",
} as const;

/** Status glyphs, matching the web client and the terminal's own vocabulary. */
export const GLYPH: Record<string, string> = {
  blocked: "●",
  working: "◐",
  done: "✓",
  idle: "○",
  unknown: "·",
};

export const AGENT_COLORS: Record<string, string> = {
  claude: "#d97757",
  codex: "#10a37f",
  gemini: "#8bb8e8",
  pi: "#c4a7ff",
  opencode: "#99ffe4",
};
