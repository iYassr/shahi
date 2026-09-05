import { brandColors } from "@shahi/shared/brand";

/** Shahi: warm neutrals with amber reserved for actions and attention. See docs/brand/README.md. */
export const theme = {
  /** Kettle Black — backgrounds, ~70% of any screen. */
  void: brandColors.void,
  surface: brandColors.surface,
  /** Steeped — raised surfaces, ~20%. */
  raised: brandColors.raised,
  line: brandColors.line,
  lineBright: brandColors.lineBright,
  dim: brandColors.muted,
  /** Porcelain — text. */
  fg: brandColors.text,
  /** Amber — blocked, the one thing that needs you. */
  peach: brandColors.accent,
  /** Completed work and successful connections. */
  mint: brandColors.success,
  /** Work in progress; provider artwork keeps its own color. */
  working: brandColors.working,
  /** Error / exited. */
  rose: brandColors.danger,
  mono: "Menlo",
} as const;

export const AGENT_COLORS: Record<string, string> = {
  claude: "#d97757",
  codex: "#10a37f",
  gemini: "#8bb8e8",
  pi: "#c4a7ff",
  opencode: "#5FB88A",
};

/** Status meaning is shared by every native agent and space surface. */
export const statusColor = (status: string) =>
  status === "working" ? theme.working
    : status === "blocked" ? theme.peach
    : status === "done" ? theme.mint
    : status === "exited" ? theme.rose
    : theme.dim;
