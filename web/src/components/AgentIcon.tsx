/**
 * Per-agent marks.
 *
 * With fifteen agents across ten spaces, "claude" and "codex" as grey text are
 * hard to scan; a coloured mark is legible at a glance and survives being small.
 *
 * On fidelity, deliberately: only marks that can be drawn *correctly* are drawn.
 * Claude's burst, Gemini's four-point sparkle and π are simple, unambiguous
 * shapes. Most of the others — OpenAI's knot, Cursor's, Copilot's — are not
 * reproducible from memory at this size, and a wrong approximation of a
 * recognisable logo looks worse than no logo at all. Those get a lettermark in
 * the agent's own colour, which reads as a deliberate system rather than a set
 * of half-remembered traces.
 *
 * To use official artwork instead, drop an SVG path into `MARKS` keyed by kind;
 * everything else picks it up.
 */

import type { ReactElement } from "react";

interface Props {
  /** herdr's agent kind: claude, codex, pi, gemini, … */
  kind: string | null | undefined;
  size?: number;
}

/**
 * Accent per agent. Chosen to stay legible on Vesper's near-black and to be
 * distinguishable from each other at 14px, which matters more here than exact
 * brand matching.
 */
const COLORS: Record<string, string> = {
  claude: "#d97757",
  codex: "#10a37f",
  gemini: "#8bb8e8",
  cursor: "#e6e6e6",
  copilot: "#b0b0b0",
  pi: "#c4a7ff",
  opencode: "#99ffe4",
  droid: "#a4e05a",
  amp: "#ffd166",
  grok: "#f0f0f0",
  devin: "#7ec8f0",
  cline: "#7de3c3",
  kimi: "#ff9ecb",
  kiro: "#ffb37a",
  hermes: "#c9b6ff",
  kilo: "#8fd3ff",
  agy: "#ffd6a0",
  maki: "#ff9d9d",
  grok3: "#f0f0f0",
  mastracode: "#9fe8c0",
  qodercli: "#c0c8ff",
  omp: "#e0b0ff",
};

const FALLBACK = "#8b8b8b";

/** Marks confident enough to draw. Everything else falls back to a lettermark. */
const MARKS: Record<string, (color: string) => ReactElement> = {
  // Anthropic's burst — the same shape Claude Code spins as `✻` in the terminal.
  claude: (color) => (
    <g stroke={color} strokeWidth="2.1" strokeLinecap="round">
      <line x1="12" y1="3.5" x2="12" y2="20.5" />
      <line x1="4" y1="7.5" x2="20" y2="16.5" />
      <line x1="4" y1="16.5" x2="20" y2="7.5" />
    </g>
  ),

  // A four-pointed sparkle with concave sides.
  gemini: (color) => (
    <path
      fill={color}
      d="M12 2c.6 5 4.4 8.8 9.4 9.4-5 .6-8.8 4.4-9.4 9.4-.6-5-4.4-8.8-9.4-9.4C7.6 10.8 11.4 7 12 2Z"
    />
  ),
};

export function AgentIcon({ kind, size = 14 }: Props) {
  const key = (kind ?? "").toLowerCase();
  const color = COLORS[key] ?? FALLBACK;
  const mark = MARKS[key];

  if (mark) {
    return (
      <svg
        className="agenticon"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        role="img"
        aria-label={kind ?? "agent"}
      >
        {mark(color)}
      </svg>
    );
  }

  // π is a real glyph, so it needs no drawing.
  const letter = key === "pi" ? "π" : (key[0] ?? "?").toUpperCase();

  return (
    <span
      className="agenticon agenticon--letter"
      style={{ width: size, height: size, color, borderColor: color }}
      role="img"
      aria-label={kind ?? "agent"}
    >
      {letter}
    </span>
  );
}
