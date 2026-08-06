/**
 * The shahi brand palette — amber on warm black (brand guidelines v1.0).
 *
 * A dark terminal with one warm light in it: amber is strong tea and a
 * phosphor cursor, spent sparingly on cursors, CTAs, and live states.
 * Deliberately not shared with the archived web client, which keeps Vesper:
 * the native app is the product and carries the brand.
 */
export const theme = {
  /** Kettle Black — backgrounds, ~70% of any screen. */
  void: "#0E0D0B",
  surface: "#14120F",
  /** Steeped — raised surfaces, ~20%. */
  raised: "#1C1915",
  line: "#2A2620",
  lineBright: "#3A352C",
  dim: "#A6A099",
  /** Porcelain — text. */
  fg: "#F0EFEA",
  /** Amber — blocked, the one thing that needs you. */
  peach: "#E8A33D",
  /** Running. */
  mint: "#5FB88A",
  /** Error / exited. */
  rose: "#D96A4A",
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
  opencode: "#5FB88A",
};
