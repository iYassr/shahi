import { Easing, interpolate, spring } from "remotion";
import { FPS } from "./theme";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const ease = Easing.bezier(0.2, 0, 0, 1);

/** 0 → 1 over `dur` frames starting at `start`, eased. */
export const ramp = (f: number, start: number, dur = 12) =>
  interpolate(f, [start, start + dur], [0, 1], { ...clamp, easing: ease });

/** Visible between `start` and `end`, fading at both edges. */
export const window = (f: number, start: number, end: number, dur = 10) =>
  Math.min(ramp(f, start, dur), 1 - ramp(f, end - dur, dur));

/** Brand motion is short and quiet: a critically damped settle, no overshoot. */
export const settle = (f: number, start: number) =>
  spring({ frame: f - start, fps: FPS, config: { damping: 200, stiffness: 120 } });

export const lerp = (t: number, a: number, b: number) => a + (b - a) * t;

/** Characters of `text` typed by frame `f`, at `cps` characters per second. */
export const typed = (text: string, f: number, start: number, cps = 32) =>
  text.slice(0, Math.max(0, Math.floor(((f - start) / FPS) * cps)));
