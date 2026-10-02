import { agentColors, brandColors } from "@shahi/shared/brand";

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

export const AGENT_COLORS = agentColors;

/**
 * How wide `columns` characters of `theme.mono` are. Terminal rows are given
 * this width inside a sideways scroll, or they wrap to the card and a menu's
 * columns stop lining up. Menlo's advance is 0.6 of its size; a little over
 * keeps the last column whole.
 */
export const monoWidth = (columns: number, fontSize: number, fontScale: number) =>
  Math.ceil(columns * fontSize * 0.62 * fontScale) + 4;

/** Status meaning is shared by every native agent and space surface. */
export const statusColor = (status: string) =>
  status === "working" ? theme.working
    : status === "blocked" ? theme.peach
    : status === "done" ? theme.mint
    : status === "exited" ? theme.rose
    : theme.dim;
