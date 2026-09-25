// Values from docs/brand/README.md (owned by shared/src/brand.ts). Copied rather
// than imported so this project stays outside the workspace and its build.
export const c = {
  void: "#0E0D0B",
  surface: "#14120F",
  steeped: "#1C1915",
  line: "#2A2620",
  lineBright: "#3A352C",
  text: "#F0EFEA",
  muted: "#A6A099",
  amber: "#E8A33D",
  blue: "#8BB8E8",
  sage: "#5FB88A",
  terracotta: "#D96A4A",
};

export const sans = '"IBM Plex Sans", system-ui, sans-serif';
export const mono = '"IBM Plex Mono", ui-monospace, monospace';

export const FPS = 30;
export const DURATION = 30 * FPS;

// Scene boundaries, in frames.
export const S = {
  terminal: 0,
  away: 105,
  inbox: 195,
  tap: 330,
  reader: 420,
  trust: 645,
  end: 765,
};
