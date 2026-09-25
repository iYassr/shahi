import { FPS } from "../theme";

// The launch cut's timeline, in frames at 30 fps. The picture (scenes.tsx) and
// the soundtrack (audio/generate.ts) both read it, so every sound lands on the
// frame of the action it belongs to; moving a cue here moves both.
//
// At 120 BPM a beat is exactly 15 frames and a bar 60. The hook is a bar and a
// half of pickup, and every cut after it falls on a bar line, so the music
// changes section on the cut instead of drifting against it.
export const BPM = 120;
export const BEAT = (60 / BPM) * FPS;

// The problem scene is three bars, not two: the voice-over's sigh and its
// "Pinch, scroll, squint." need 4.5s, and a performed read will not hurry.
export const T = {
  hook: 0,
  problem: 90,
  setup: 270,
  chat: 450,
  herdr: 690,
  end: 810,
  total: 960,
};

/** Seconds from the start of the video to `frame`. */
export const sec = (frame: number) => frame / FPS;

/**
 * When the `k`-th character of text typed from `start` at `cps` appears (see
 * motion.ts `typed`), as a fractional frame: the picture shows it on the first
 * whole frame at or after this, and the keystroke sound lands exactly on it.
 */
export const keyFrame = (start: number, cps: number, k: number) => start + (k * FPS) / cps;

export const HOOK = {
  line1: "You left your desk.",
  line1At: 6,
  line2: "Your agents didn't.",
  line2At: 36,
  stagger: 5,
};

export const PROBLEM = {
  panOut: T.problem + 36,
  pinch: T.problem + 76,
  panBack: T.problem + 116,
};

export const SETUP = {
  cmd1: "herdr plugin install iYassr/shahi",
  cmd1At: T.setup + 8,
  cmd1Cps: 44,
  cmd1Enter: T.setup + 34,
  installed: T.setup + 39,
  cmd2: "herdr plugin action invoke shahi.pair",
  cmd2At: T.setup + 48,
  cmd2Cps: 48,
  cmd2Enter: T.setup + 76,
  popup: T.setup + 86,
  tap: T.setup + 96,
  camera: T.setup + 102,
  lock: T.setup + 112,
  locked: T.setup + 130,
  done: T.setup + 140,
};
/** The stepper beneath the caption ticks Install, Pair and Scan on the moments that complete them. */
export const STEPS = [SETUP.installed, SETUP.popup, SETUP.done];

export const CHAT = {
  // The phone is still settling in over the first frames; the first message
  // (and its sound) waits until it can be seen.
  you: T.chat + 8,
  agent: T.chat + 14,
  tool: T.chat + 30,
  toolDone: T.chat + 44,
  edit: T.chat + 58,
  prompt: T.chat + 86,
  tapYes: T.chat + 128,
  // The amber Yes holds for 12 frames before the card becomes "✓ Answered".
  answered: T.chat + 140,
  agentDone: T.chat + 150,
  reply: "Great. Open the PR.",
  typeAt: T.chat + 168,
  typeCps: 22,
  send: T.chat + 200,
  sent: T.chat + 204,
  working: T.chat + 212,
};

export const HERDR = {
  /** Each herdr pane lights up, then its row lands on the phone. */
  panes: [0, 1, 2, 3].map((i) => T.herdr + 16 + i * 14),
  rows: [0, 1, 2, 3].map((i) => T.herdr + 26 + i * 14),
};

export const END = {
  mark: T.end + 2,
  line: T.end + 14,
  chips: [0, 1, 2].map((i) => T.end + 28 + i * 6),
  cmd: T.end + 50,
};
