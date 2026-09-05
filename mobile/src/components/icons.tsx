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
import { agentMarks, brandMark, brandWordmark } from "@shahi/shared/brand";
import Svg, { G, Path, Rect } from "react-native-svg";

/** The tea glass and rising cursor use the same geometry as every exported mark. */
export function Logo({ color, size = 24 }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Rect {...brandMark.cursor} fill={color} />
      <Path d={brandMark.glass} fill="none" stroke={color} strokeWidth={8} strokeLinejoin="round" />
    </Svg>
  );
}

/** Shared outlined lettering keeps the brand independent of system fonts. */
export function Wordmark({ color, width = 108 }: { color: string; width?: number }) {
  return (
    <Svg width={width} height={width * brandWordmark.height / brandWordmark.width} viewBox={brandWordmark.viewBox} accessibilityRole="image" accessibilityLabel="Shahi">
      <G transform={`translate(${brandWordmark.translateX} 0)`}>
        <Path d={brandWordmark.path} fill="none" stroke={color} strokeWidth={brandWordmark.strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
        <Rect {...brandWordmark.dot} fill={color} />
      </G>
    </Svg>
  );
}

const ICONS = {
  copy: { d: "M9 9h11v11H9zM5 15H3V3h12v2", filled: false },
  check: { d: "m5 12 4 4L19 6", filled: false },
  bell: { d: "M10.268 21a2 2 0 0 0 3.464 0m-10.47-5.674A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326", filled: false },
  "bell-off": { d: "M10.268 21a2 2 0 0 0 3.464 0M17 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6 6 0 0 1 .258-1.742M2 2l20 20M8.668 3.01A6 6 0 0 1 18 8c0 2.687.77 4.653 1.707 6.05", filled: false },
  pin: { d: "M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4a1 1 0 0 1 1 1z", filled: false },
  "pin-off": { d: "M12 17v5m3-12.66V7a1 1 0 0 1 1-1a2 2 0 0 0 0-4H7.89M2 2l20 20M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11", filled: false },
  terminal: { d: "M12 19h8M4 17l6-6l-6-6", filled: false },
  // Claude Code's own mark — the pixel robot — not Anthropic's A: the avatar
  // names the agent on the pane, and the agent is Claude Code.
  claudecode: { d: agentMarks.claudecode, filled: true },
  openai: { d: agentMarks.openai, filled: true },
  "math-pi": { d: "M7 20V4m10 0v16m3-16H4", filled: false },
  // Multi-shape Lucide icons, their rects and circles rewritten as path data
  // so one <Path> renders them.
  server: { d: "M4 2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM4 14h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2zM6 6h.01M6 18h.01", filled: false },
  "log-out": { d: "m16 17l5-5l-5-5m5 5H9m0 9H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", filled: false },
  info: { d: "M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20M12 16v-4m0-4h.01", filled: false },
  activity: { d: "M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2", filled: false },
  "chevron-down": { d: "m6 9 6 6 6-6", filled: false },
  "chevron-up": { d: "m18 15-6-6-6 6", filled: false },
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
