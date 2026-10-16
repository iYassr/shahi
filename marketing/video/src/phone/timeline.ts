import { FPS } from "../theme";

// The phone cut's timeline, in frames at 30 fps. The picture (scenes.tsx), the
// soundtrack (audio/phone.ts) and the voice-over (audio/phone-voiceover.ts)
// all read it, as the launch cut's do.
//
// 120 BPM, so a bar is 60 frames and every cut sits on a bar line. Scene
// lengths were set from the spoken takes: each line starts a few frames after
// its cut and ends before the next one, and the scenes whose footage needs
// longer than their line (Reader, herdr, setup) keep the rest for the picture.
export const BPM = 120;
export const BEAT = (60 / BPM) * FPS;
export const BAR = 4 * BEAT;

export const T = {
  problem: 0,
  reader: 180,
  answer: 360,
  agents: 540,
  herdr: 720,
  setup: 900,
  reach: 1200,
  more: 1440,
  end: 1620,
  total: 1800,
};

export const sec = (frame: number) => frame / FPS;

/** When the `k`-th character typed from `start` at `cps` appears (motion.ts `typed`). */
export const keyFrame = (start: number, cps: number, k: number) => start + (k * FPS) / cps;

// Frames below are placed on the spoken words, measured from the takes'
// waveforms (ElevenLabs' alignment gives each pause to the word after it, half
// a second early), or on the footage's own movements (capture.ts prints them).

export const PROBLEM = {
  // "Pinch," "scroll," "squint."
  pinch: T.problem + 104,
  scroll: T.problem + 122,
  squint: T.problem + 142,
};

export const READER = {
  /** reader.mp4: the push into the conversation ends on frame 28; the scroll up to the question runs 53 to 76. */
  scrollAt: T.reader + 70,
};

export const ANSWER = {
  // "tap to answer" in the take; answer.mp4 shows "Answer sent" from its frame 14.
  tap: T.answer + 45,
  // The computer moves on (answer.mp4 frame 234): the card becomes a working row.
  working: T.answer + 112,
  // "Shahi checks the live screen first."
  check: T.answer + 100,
};

/** Each agent's name in the take; new-agent.mp4 selects them on its frames 74, 98, 122 and 145. */
export const AGENTS = {
  names: [
    { name: "Claude Code", at: T.agents + 4, clip: 50 },
    { name: "Codex", at: T.agents + 39, clip: 74, x: 196 },
    { name: "Cursor", at: T.agents + 73, clip: 98, x: 302 },
    { name: "OpenCode", at: T.agents + 107, clip: 122, x: 78, row: 1 },
    { name: "Antigravity", at: T.agents + 148, clip: 145, x: 212, row: 1 },
  ],
  /** Back to Claude (frame 170), whose permission modes fill the sheet under "the permissions you choose". */
  back: { at: T.agents + 164, clip: 170, x: 78 },
};

export const HERDR = {
  // spaces.mp4: the Spaces tab on its frame 19, tasks-web pushed from 93, on "Every space".
  spacesTab: T.herdr + 14,
  pick: T.herdr + 88,
};

export const SETUP = {
  cmd: "curl -fsSL https://getshahi.dev/install | sh",
  cmdAt: T.setup + 10,
  cmdCps: 52,
  enter: T.setup + 38,
  /** The installer's steps, as site/install.sh prints them. */
  steps: [T.setup + 44, T.setup + 50, T.setup + 56, T.setup + 62],
  qr: T.setup + 66,
  tap: T.setup + 76,
  camera: T.setup + 80,
  lock: T.setup + 86,
  locked: T.setup + 100,
  connected: T.setup + 108,
  // "End-to-end encrypted, no VPN, no account." ticks its chips.
  chips: [T.setup + 87, T.setup + 128, T.setup + 140, T.setup + 160],
  // "Or use SSH." is spoken from T.setup + 197.
  ssh: T.setup + 190,
};

export const REACH = {
  banner: T.reach + 14,
  tapBanner: T.reach + 52,
  open: T.reach + 58,
  // "and say your reply…"
  dictate: T.reach + 74,
  mic: T.reach + 84,
  words: "Retry three times, then keep it for the next launch",
  wordsAt: T.reach + 96,
  wordsCps: 17,
  add: T.reach + 196,
  send: T.reach + 214,
};

export const MORE = {
  // "Review diffs," "run slash commands," "check your plan limits," then the languages.
  beats: [T.more, T.more + 38, T.more + 88, T.more + 128, T.more + 154],
};

export const END = {
  mark: T.end + 2,
  line: T.end + 30,
  chips: [0, 1, 2].map((i) => T.end + 48 + i * 6),
  url: T.end + 72,
};
