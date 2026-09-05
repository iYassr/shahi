/** Agent identities share the native artwork; unknown providers retain a lettermark. */
import { agentMarks } from "@shahi/shared/brand";
import type { ReactElement } from "react";

interface Props {
  /** herdr's agent kind: claude, codex, pi, gemini, … */
  kind: string | null | undefined;
  size?: number;
}

/**
 * Accent per agent. Chosen to stay legible on Shahi's warm black and to be
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
  opencode: "#5FB88A",
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

const FALLBACK = "var(--muted)";

/** Marks confident enough to draw. Everything else falls back to a lettermark. */
const MARKS: Record<string, (color: string) => ReactElement> = {
  claude: (color) => <path fill={color} d={agentMarks.claudecode} />,
  codex: (color) => <path fill={color} d={agentMarks.openai} />,

  // A four-pointed sparkle with concave sides.
  gemini: (color) => (
    <path
      fill={color}
      d="M12 2c.6 5 4.4 8.8 9.4 9.4-5 .6-8.8 4.4-9.4 9.4-.6-5-4.4-8.8-9.4-9.4C7.6 10.8 11.4 7 12 2Z"
    />
  ),
};

export function agentColor(kind: string | null | undefined) { return COLORS[(kind ?? "").toLowerCase()] ?? FALLBACK; }

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
