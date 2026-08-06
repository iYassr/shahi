/**
 * Chrome and identity icons, from Iconify (https://iconify.design).
 *
 * Chrome comes from Lucide (ISC), agent identities from Simple Icons
 * (CC0/brand) and Tabler (MIT): Anthropic's mark for claude, OpenAI's for
 * codex, a pi for pi. Path data fetched once from the Iconify API and
 * embedded, because an app that talks to one server on a tailnet should not
 * also fetch icons from a CDN at runtime. Status marks in lists stay
 * terminal glyphs (○ ◐ ✳ ❯) — they are the terminal's own vocabulary.
 */
import Svg, { Path, Rect } from "react-native-svg";

/**
 * The Cup Cursor — the brand mark, from the shahi brand guidelines v1.0.
 *
 * A tea glass drawn as a terminal block cursor; the lid is the cursor and is
 * the only part that may blink. Geometry is fixed by the guidelines (no
 * rotation, stretching, or recoloring beyond a single ink), so it takes one
 * color and a size, nothing else.
 */
export function Logo({ color, size = 24 }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Rect x={44} y={6} width={12} height={9} rx={2} fill={color} />
      <Rect x={31} y={24} width={38} height={54} rx={9} fill="none" stroke={color} strokeWidth={6} />
      <Rect x={38} y={55} width={24} height={16} rx={4} fill={color} />
    </Svg>
  );
}

const ICONS = {
  bell: { d: "M10.268 21a2 2 0 0 0 3.464 0m-10.47-5.674A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326", filled: false },
  "bell-off": { d: "M10.268 21a2 2 0 0 0 3.464 0M17 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6 6 0 0 1 .258-1.742M2 2l20 20M8.668 3.01A6 6 0 0 1 18 8c0 2.687.77 4.653 1.707 6.05", filled: false },
  pin: { d: "M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4a1 1 0 0 1 1 1z", filled: false },
  "pin-off": { d: "M12 17v5m3-12.66V7a1 1 0 0 1 1-1a2 2 0 0 0 0-4H7.89M2 2l20 20M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11", filled: false },
  terminal: { d: "M12 19h8M4 17l6-6l-6-6", filled: false },
  // Claude Code's own mark — the pixel robot — not Anthropic's A: the avatar
  // names the agent on the pane, and the agent is Claude Code.
  claudecode: { d: "M21 10.5h3v3h-3v3h-1.5v3H18v-3h-1.5v3H15v-3H9v3H7.5v-3H6v3H4.5v-3H3v-3H0v-3h3v-6h18Zm-15 0h1.5v-3H6Zm10.5 0H18v-3h-1.5z", filled: true },
  openai: { d: "M22.282 9.821a6 6 0 0 0-.516-4.91a6.05 6.05 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a6 6 0 0 0-3.998 2.9a6.05 6.05 0 0 0 .743 7.097a5.98 5.98 0 0 0 .51 4.911a6.05 6.05 0 0 0 6.515 2.9A6 6 0 0 0 13.26 24a6.06 6.06 0 0 0 5.772-4.206a6 6 0 0 0 3.997-2.9a6.06 6.06 0 0 0-.747-7.073M13.26 22.43a4.48 4.48 0 0 1-2.876-1.04l.141-.081l4.779-2.758a.8.8 0 0 0 .392-.681v-6.737l2.02 1.168a.07.07 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494M3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085l4.783 2.759a.77.77 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646M2.34 7.896a4.5 4.5 0 0 1 2.366-1.973V11.6a.77.77 0 0 0 .388.677l5.815 3.354l-2.02 1.168a.08.08 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.08.08 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667m2.01-3.023l-.141-.085l-4.774-2.782a.78.78 0 0 0-.785 0L9.409 9.23V6.897a.07.07 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.8.8 0 0 0-.393.681zm1.097-2.365l2.602-1.5l2.607 1.5v2.999l-2.597 1.5l-2.607-1.5Z", filled: true },
  "math-pi": { d: "M7 20V4m10 0v16m3-16H4", filled: false },
  // Multi-shape Lucide icons, their rects and circles rewritten as path data
  // so one <Path> renders them.
  server: { d: "M4 2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM4 14h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2zM6 6h.01M6 18h.01", filled: false },
  "log-out": { d: "m16 17l5-5l-5-5m5 5H9m0 9H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", filled: false },
  info: { d: "M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20M12 16v-4m0-4h.01", filled: false },
  activity: { d: "M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2", filled: false },
} as const;

export type IconName = keyof typeof ICONS;

/** The mark an agent kind signs its avatar with; null falls back to a glyph. */
export const AGENT_ICONS: Record<string, IconName> = {
  claude: "claudecode",
  codex: "openai",
  pi: "math-pi",
};

export function Icon({ name, color, size = 18 }: { name: IconName; color: string; size?: number }) {
  const icon = ICONS[name];
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d={icon.d}
        fill={icon.filled ? color : "none"}
        stroke={icon.filled ? undefined : color}
        strokeWidth={icon.filled ? undefined : 2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
