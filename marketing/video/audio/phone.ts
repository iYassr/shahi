// Renders the phone cut's soundtrack, voice-over, music and sound effects in
// one mixed stereo WAV, from the timeline the picture reads
// (src/phone/timeline.ts), and the voice-over's captions. The launch cut's
// generate.ts, in the same voice and on the same instruments: seeded, so the
// same bytes every run.
//
//   bun audio/phone.ts                  → public/audio/phone.wav, out/shahi-phone.en.{vtt,srt}
//   bun audio/phone.ts --stems <dir>    … and each bus beside it

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENTS, ANSWER, BAR, BEAT, END, HERDR, keyFrame, MORE, PROBLEM, REACH, sec, SETUP, T } from "../src/phone/timeline";
import { CLEAN_TAIL_DB, decode, speechRuns, tailDb } from "./decode";
import * as d from "./dsp";
import { speakPhone } from "./phone-voiceover";

const { SR } = d;
const N = Math.round(sec(T.total) * SR);
const r = d.rng(20261016);

const bus = () => d.stereo(N);
const pads = bus(), bassBus = bus(), drums = bus(), arp = bus(), fx = bus();
const sfx = bus(), chimes = bus();
const verb = bus(), sfxVerb = bus(), echo = bus();

/* ------------------------------------------------------------- harmony */

// The launch cut's key: B minor into D major. The terminal sits on unresolved
// chords; the app moves through D; the end resolves on D with an added ninth.
type Chord = { pad: number[]; bass: number; tones: number[] };
const ch = (pad: number[], bass: number): Chord => ({ pad, bass, tones: pad.slice(-4).map((m) => m + 12) });
const Bm = ch([47, 54, 59, 62, 66], 35);
const Gmaj7 = ch([43, 50, 54, 59, 62], 31);
const Fsus = ch([42, 49, 54, 59, 61], 30);
const D = ch([50, 57, 62, 66, 69], 38);
const AoverCs = ch([49, 57, 61, 64, 69], 37);
const G = ch([47, 55, 59, 62, 67], 31);
const A = ch([49, 57, 61, 64, 69], 33);
const Em = ch([52, 55, 59, 64, 67], 28);
const Dadd9 = ch([50, 57, 64, 66, 69, 74], 26);

type Groove = "tick" | "half" | "full" | "drive";
type Section = { from: number; chords: Chord[]; cutoff: [number, number]; groove: Groove; arp: 0 | 8 | 16; last?: boolean };

/** A section spans one scene, one chord a bar; a scene that leaves the bar grid stops the build. */
const section = (from: number, to: number, chords: Chord[], cutoff: [number, number], groove: Groove, arp: 0 | 8 | 16, last = false): Section => {
  if (from % BAR || to % BAR) throw new Error(`The scene from frame ${from} to ${to} is not on bar lines (every ${BAR} frames).`);
  if ((to - from) / BAR !== chords.length) throw new Error(`The scene from frame ${from} is ${(to - from) / BAR} bars long but has ${chords.length} chords.`);
  return { from, chords, cutoff, groove, arp, last };
};
const sections: Section[] = [
  section(T.problem, T.reader, [Gmaj7, Em, Fsus], [650, 1000], "tick", 0),
  section(T.reader, T.answer, [D, AoverCs, Bm], [1100, 2200], "half", 8),
  section(T.answer, T.agents, [G, D, A], [2200, 2800], "half", 8),
  section(T.agents, T.herdr, [D, A, Bm], [2600, 3400], "full", 16),
  section(T.herdr, T.setup, [G, Em, A], [2800, 3600], "full", 16),
  section(T.setup, T.reach, [D, AoverCs, Bm, G, A], [3000, 4600], "drive", 16),
  section(T.reach, T.more, [Bm, G, D, A], [1600, 2600], "half", 8),
  section(T.more, T.end, [Em, G, A], [3400, 5000], "drive", 16, true),
];

const barSec = sec(BAR), beatSec = sec(BEAT);
const kicks: number[] = [];

// Under the first words: a low drone and a single pluck as the phone arrives.
d.place(bassBus, d.bass(35, sec(T.reader) - 0.2), 0.1, 0.16);
{
  const pl = d.pluck(59, 0.6, 0.6);
  d.place(arp, pl, 0.2, 0.12, -0.2);
  d.place(verb, pl, 0.2, 0.3, -0.2);
}

for (const s of sections) {
  s.chords.forEach((c, i) => {
    const at = sec(s.from + i * BAR);
    const span = s.chords.length;
    const lo = s.cutoff[0] * (s.cutoff[1] / s.cutoff[0]) ** (i / span);
    const hi = s.cutoff[0] * (s.cutoff[1] / s.cutoff[0]) ** ((i + 1) / span);
    const p = d.pad(c.pad, barSec, { cutoff: [lo, hi], attack: 0.18, release: 0.7, seed: 10 + s.from / BAR + i });
    d.placeStereo(pads, p, at, s.groove === "tick" ? 0.34 : 0.3);
    d.placeStereo(verb, p, at, 0.12);

    for (let b = 0; b < 4; b++) {
      const t = at + b * beatSec;
      const final = s.last && i === span - 1;
      if (s.groove === "tick") {
        for (const e of [0, 0.5]) d.place(drums, d.hat(r), t + e * beatSec, e === 0 ? 0.2 : 0.13, 0.3);
        if (b === 0 || b === 2) {
          d.place(bassBus, d.bass(c.bass, 0.35), t, 0.35);
          d.place(bassBus, d.bass(c.bass + 24, 0.35), t, 0.22);
        }
        continue;
      }
      const kickHere = s.groove === "drive" || b === 0 || b === 2;
      if (kickHere) { d.place(drums, d.kick(r), t, 0.62); kicks.push(t); }
      if (s.groove === "full" && b === 2) { d.place(drums, d.kick(r), t + 0.5 * beatSec, 0.28); kicks.push(t + 0.5 * beatSec); }
      if ((s.groove === "full" || s.groove === "drive") && (b === 1 || b === 3) && !(final && b === 3)) {
        const sn = d.snap(r);
        d.place(drums, sn, t, 0.3, 0.05);
        d.place(verb, sn, t, 0.25, 0.05);
      }
      const steps = s.groove === "half" ? 2 : 4;
      for (let k = 0; k < steps; k++) {
        const accent = k % 2 === 0 ? 1 : 0.6;
        d.place(drums, d.hat(r, s.groove === "full" && b === 3 && k === 2), t + (k / steps) * beatSec, (s.groove === "half" ? 0.06 : 0.07) * accent, 0.35);
      }
      for (const e of [0, 0.5]) {
        const up = s.groove !== "half" && e === 0.5 && b % 2 === 1 ? 12 : 0;
        d.place(bassBus, d.bass(c.bass + up, beatSec * 0.42), t + e * beatSec, 0.32);
      }
      // A snare roll into the end card.
      if (final && b === 3) {
        for (let k = 0; k < 4; k++) {
          const sn = d.snap(r);
          d.place(drums, sn, t + (k / 4) * beatSec, 0.14 + k * 0.06, 0.05);
          d.place(verb, sn, t + (k / 4) * beatSec, 0.15);
        }
      }
    }

    if (s.arp) {
      const pattern = s.arp === 8 ? [0, 1, 2, 3, 2, 1, 2, 3] : [0, 2, 1, 3, 2, 0, 3, 1, 0, 2, 1, 3, 2, 3, 1, 2];
      pattern.forEach((idx, k) => {
        const t = at + (k / pattern.length) * barSec;
        const pl = d.pluck(c.tones[idx], s.arp === 8 ? 0.32 : 0.22, 0.8);
        const g = (k % (pattern.length / 4) === 0 ? 0.22 : 0.15) * (s.arp === 8 ? 1 : 0.85);
        const pan = ((k % 4) - 1.5) * 0.25;
        d.place(arp, pl, t, g, pan);
        d.place(echo, pl, t, g * 0.8, pan);
        d.place(verb, pl, t, g * 0.5, pan);
      });
    }
  });
}

// The rest rises into the end card, which settles on one wide chord.
d.place(fx, d.riser(r, sec(T.end - T.more)), sec(T.more), 0.12);
{
  const at = sec(T.end);
  const hold = sec(T.total - T.end) - 0.9;
  const p = d.pad(Dadd9.pad, hold, { cutoff: [5200, 1600], attack: 0.02, release: 1.2, seed: 99 });
  d.placeStereo(pads, p, at, 0.36);
  d.placeStereo(verb, p, at, 0.2);
  d.place(bassBus, d.bass(Dadd9.bass + 12, 2.2), at, 0.5);
  d.place(drums, d.kick(r), at, 0.6);
  kicks.push(at);
  d.place(fx, d.boom(r, 2.2, d.hz(26)), at, 0.5);
  const a = d.air(r, 2.8);
  d.place(fx, a, at, 0.22, -0.2);
  d.place(fx, a, at + 0.011, 0.22, 0.2);
  d.place(arp, d.pluck(62, 0.9, 0.5), sec(END.url), 0.12);
  d.place(echo, d.pluck(62, 0.9, 0.5), sec(END.url), 0.12);
}

/* ------------------------------------------------------- sound effects */

const typeKeys = (text: string, start: number, cps: number, gain: number, pan: number) => {
  [...text].forEach((c, k) => d.place(sfx, d.key(r, c === " " ? "space" : "key"), sec(keyFrame(start, cps, k + 1)), gain, pan + (r() - 0.5) * 0.1));
};
const whooshAt = (frame: number, len = 0.6, from = -0.5, to = 0.6, g = 0.3) => d.placeStereo(sfx, d.whoosh(r, len, from, to), sec(frame), g);
const bells = (notes: [number, number][], frame: number, g: number, pan: number, decay: number) => {
  for (const [m, dt] of notes) {
    const b = d.bell(m, decay);
    d.place(chimes, b, sec(frame) + dt, g, pan);
    d.place(sfxVerb, b, sec(frame) + dt, g * 0.5, pan);
  }
};
const tap = (frame: number, g = 0.34, pan = 0.35) => d.place(sfx, d.tap(r), sec(frame), g, pan);
const popOn = (m: number, len?: number) => d.pop(d.hz(m) / 1.83, d.hz(m), len);

// The terminal: the phone arrives, a pinch, a drag, a pinch out.
whooshAt(2, 0.65, 0.7, 0.2);
d.place(sfx, d.tap(r), sec(PROBLEM.pinch - 2), 0.18, 0.3);
d.place(sfx, d.tap(r), sec(PROBLEM.pinch - 1), 0.16, 0.5);
whooshAt(PROBLEM.scroll, 0.55, 0.5, -0.1, 0.12);
d.place(sfx, d.tap(r), sec(PROBLEM.squint - 2), 0.16, 0.3);
whooshAt(PROBLEM.squint, 0.45, -0.1, 0.5, 0.1);

// Reader: the terminal turns into the conversation.
whooshAt(T.reader - 6, 0.6, -0.4, 0.5);
d.place(chimes, popOn(81), sec(T.reader + 6), 0.24, 0.3);

// One-tap answers.
whooshAt(T.answer - 6, 0.5, 0.4, -0.3, 0.22);
tap(ANSWER.tap);
bells([[86, 0], [90, 0.05]], ANSWER.tap + 3, 0.17, 0.3, 0.4);
d.place(chimes, popOn(78), sec(ANSWER.working), 0.24, 0.3);

// Every agent: each name lands as a note of the chord under it.
whooshAt(T.agents - 6, 0.6, -0.5, 0.4);
AGENTS.names.forEach((n, i) => {
  if (n.x) tap(n.at - 2, 0.26);
  const pl = d.pluck([74, 78, 81, 85, 86][i], 0.45, 1);
  d.place(chimes, pl, sec(n.at), 0.13, 0.45);
  d.place(sfxVerb, pl, sec(n.at), 0.1, 0.45);
});
tap(AGENTS.back.at - 2, 0.24);

// herdr: the window arrives, the phone opens the same space, its panes light.
whooshAt(T.herdr - 6, 0.6, 0.5, -0.3);
tap(HERDR.spacesTab);
tap(HERDR.pick);
[0, 1, 2, 3].forEach((i) => {
  const pl = d.pluck([79, 83, 86, 90][i], 0.4, 1);
  d.place(chimes, pl, sec(HERDR.pick + 6 + i * 7), 0.11, -0.4);
  d.place(sfxVerb, pl, sec(HERDR.pick + 6 + i * 7), 0.08, -0.4);
});

// Setup: one command typed and entered, the installer's steps, the code, the scan, connected.
whooshAt(T.setup - 4, 0.6, -0.6, 0.4);
typeKeys(SETUP.cmd, SETUP.cmdAt, SETUP.cmdCps, 0.2, -0.2);
d.place(sfx, d.key(r, "enter"), sec(SETUP.enter), 0.3, -0.2);
SETUP.steps.forEach((s, i) => d.place(chimes, d.blip([74, 78, 81, 86][i], 0.15), sec(s), 0.08, -0.2));
d.place(chimes, popOn(81, 0.2), sec(SETUP.qr), 0.26, -0.1);
tap(SETUP.tap, 0.34, 0.45);
d.placeStereo(sfx, d.whoosh(r, 0.3, 0.3, 0.6, 1600), sec(SETUP.camera), 0.14);
d.place(sfx, d.key(r), sec(SETUP.locked), 0.2, 0.45);
d.place(sfx, d.key(r), sec(SETUP.locked + 3), 0.16, 0.45);
bells([[86, 0], [93, 0.09]], SETUP.connected, 0.2, 0.4, 0.35);
SETUP.chips.forEach((frame, i) => d.place(chimes, d.blip([81, 86, 88, 90][i], 0.22), sec(frame), 0.1, -0.2 + i * 0.15));
whooshAt(SETUP.ssh - 4, 0.5, -0.3, 0.5, 0.2);
// Where ssh.mp4's typing lands once the scene has sped it up (scenes.tsx).
typeKeys("workstation.local", SETUP.ssh + 16, 24, 0.14, 0.4);
typeKeys("maya", SETUP.ssh + 62, 12, 0.14, 0.4);

// Notifications and dictation: the banner, the tap, the microphone, Add, Send.
whooshAt(T.reach - 6, 0.6, 0.4, -0.4);
bells([[81, 0], [88, 0.11]], REACH.banner, 0.18, 0.35, 0.35);
tap(REACH.tapBanner);
d.placeStereo(sfx, d.whoosh(r, 0.35, 0.2, 0.5, 2200), sec(REACH.open - 2), 0.14);
tap(REACH.mic, 0.3);
d.place(chimes, d.blip(86, 0.2), sec(REACH.mic + 3), 0.1, 0.35);
tap(REACH.add, 0.3);
tap(REACH.send, 0.34, 0.45);
d.placeStereo(sfx, d.whoosh(r, 0.28, 0.1, 0.7, 3600), sec(REACH.send + 1), 0.14);
d.place(chimes, popOn(86), sec(REACH.send + 4), 0.24, 0.3);

// The rest: one beat each.
MORE.beats.forEach((frame, i) => {
  if (i < 2) tap(frame + (i === 0 ? 6 : 7), 0.28);
  d.place(chimes, d.blip([76, 79, 83, 86, 88][i], 0.2), sec(frame + 2), 0.09, 0.3);
});

// The end: a shimmer on the mark, the three facts up the chord.
bells([[86, 0], [93, 0.05], [98, 0.1]], END.mark, 0.09, 0, 0.6);
END.chips.forEach((frame, i) => d.place(chimes, d.blip([86, 90, 93][i], 0.3), sec(frame), 0.13, (i - 1) * 0.3));

/* ---------------------------------------------------------- voice-over */

const ROOT = join(import.meta.dirname, "..");
const spoken = await speakPhone();
const vo = bus();
const cues: { start: number; end: number; text: string; by: number }[] = [];

/** Caption times from the waveform; see generate.ts, whose reasons hold here. */
function captionTimes(raw: Float32Array, sentences: { text: string; start: number; end: number }[]) {
  const runs = speechRuns(raw, SR);
  const out = sentences.map((s) => ({ ...s }));
  out[0].start = runs[0][0];
  out[out.length - 1].end = runs[runs.length - 1][1];
  let last = 0;
  for (let k = 1; k < out.length; k++) {
    let best = -1, dist = Infinity;
    for (let g = last + 1; g < runs.length; g++) {
      const quietFrom = runs[g - 1][1], quietTo = runs[g][0], t = sentences[k].start;
      const dd = t < quietFrom ? quietFrom - t : t > quietTo ? t - quietTo : 0;
      if (dd < dist) { dist = dd; best = g; }
    }
    if (best > 0 && dist < 0.35) { out[k].start = runs[best][0]; out[k - 1].end = runs[best - 1][1]; last = best; }
  }
  return out;
}

const fitted = spoken.map((sp) => {
  const raw = decode(sp.mp3, SR).slice(0, Math.round(sp.cut * SR));
  const tail = tailDb(raw, SR);
  if (tail >= CLEAN_TAIL_DB) throw new Error(`The "${sp.line.id}" take stops mid-sound (its last 10 ms are ${tail.toFixed(1)} dB under its peak); delete it from audio/vo-phone/ to speak it again.`);
  const fade = Math.round(0.02 * SR);
  for (let i = 0; i < fade; i++) raw[raw.length - fade + i] *= 0.5 + 0.5 * Math.cos((Math.PI * i) / fade);
  const thr = d.peak({ l: raw, r: raw }) * 0.02;
  let on = 0, off = raw.length - 1;
  while (on < raw.length && Math.abs(raw[on]) < thr) on++;
  while (off > on && Math.abs(raw[off]) < thr) off--;
  const at = sec(sp.line.at) - on / SR;
  return { sp, raw, at, slack: sec(sp.line.by) - (at + off / SR), length: (off - on) / SR };
});
for (const f of fitted) console.log(`  voice ${f.sp.line.id.padEnd(8)} ${f.length.toFixed(2)}s, ${f.slack.toFixed(2)}s to spare before frame ${f.sp.line.by}`);
const over = fitted.filter((f) => f.slack < 0);
if (over.length) throw new Error(`Voice lines run past their cuts: ${over.map((f) => `"${f.sp.line.id}" by ${(-f.slack).toFixed(2)}s`).join(", ")}. Shorten them or start them earlier.`);

for (const { sp, raw, at } of fitted) {
  const hp = d.sweep(raw, "hp", () => 75, 0.7);
  const clip = d.compress(hp, 20 * Math.log10(d.peak({ l: hp, r: hp })) - 14, 3);
  const g = d.db(-16 - d.lufs({ l: clip, r: clip }));
  d.place(vo, clip, at, g * Math.SQRT2);
  for (const s of captionTimes(raw, sp.sentences)) cues.push({ start: at + s.start, end: at + s.end, text: s.text, by: sec(sp.line.by) });
}

/* ----------------------------------------------------------------- mix */

const pump = new Float32Array(N).fill(1);
for (const t of kicks) {
  const s0 = Math.round(t * SR);
  for (let i = s0; i < Math.min(N, s0 + Math.round(0.4 * SR)); i++) pump[i] = Math.min(pump[i], 1 - 0.32 * Math.exp(-(i - s0) / SR / 0.11));
}
d.applyGain(pads, pump);
d.applyGain(bassBus, pump);

const music = bus();
d.mix(music, pads);
d.mix(music, bassBus);
d.mix(music, drums);
d.mix(music, arp);
d.mix(music, fx);
d.mix(music, d.delay(echo, beatSec * 0.75, 0.36), 0.55);
d.mix(music, d.reverb(verb, 0.86, 0.3), 0.9);

const SFX_GAIN = d.db(6);
const effects = bus();
d.mix(effects, sfx, SFX_GAIN);
d.mix(effects, chimes, SFX_GAIN);

// The music steps back under every effect a little and under the voice about 15 dB.
const env = d.follow(effects, 0.004, 0.22);
const voEnv = d.hold(d.follow(vo, 0.03, 0.45), 0.25);
const voFull = d.peak(vo) * 0.04;
const duck = new Float32Array(N), light = new Float32Array(N), deep = new Float32Array(N);
for (let i = 0; i < N; i++) {
  const speech = Math.min(1, voEnv[i] / voFull);
  deep[i] = 1 - 0.82 * speech;
  light[i] = 1 - 0.35 * speech;
  duck[i] = (1 - 0.42 * Math.min(1, env[i] / 0.24)) * deep[i];
}
d.applyGain(music, duck);
d.applyGain(sfx, light);
d.applyGain(chimes, deep);
const chimesVerb = d.reverb(sfxVerb, 0.82, 0.35);
d.applyGain(chimesVerb, deep);

const master = bus();
d.mix(master, music);
d.mix(master, sfx, SFX_GAIN);
d.mix(master, chimes, SFX_GAIN);
d.mix(master, chimesVerb, 0.8 * SFX_GAIN);
d.mix(master, vo);

const fadeFrom = Math.round(sec(T.total - 12) * SR);
for (let i = fadeFrom; i < N; i++) {
  const g = Math.cos(((i - fadeFrom) / (N - fadeFrom)) * (Math.PI / 2)) ** 2;
  master.l[i] *= g; master.r[i] *= g;
}

// -15 LUFS integrated with a -1.5 dBFS ceiling, as the launch cut.
const TARGET = -15, CEILING = d.db(-1.5);
for (let pass = 0; pass < 3; pass++) {
  const g = d.db(TARGET - d.lufs(master));
  for (let i = 0; i < N; i++) { master.l[i] *= g; master.r[i] *= g; }
  d.limit(master, CEILING);
}

const out = join(ROOT, "public/audio/phone.wav");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, d.wav(master, d.rng(1)));

{
  const stamp = (t: number, sep: string) => {
    const ms = Math.round(t * 1000);
    const hh = String(Math.floor(ms / 3600000)).padStart(2, "0"), mm = String(Math.floor(ms / 60000) % 60).padStart(2, "0");
    const ss = String(Math.floor(ms / 1000) % 60).padStart(2, "0"), mmm = String(ms % 1000).padStart(3, "0");
    return `${hh}:${mm}:${ss}${sep}${mmm}`;
  };
  const held = cues.map((c, i) => ({ ...c, end: Math.min(c.end + 0.35, cues[i + 1]?.start ?? sec(T.total), c.by) }));
  const outDir = join(ROOT, "out");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "shahi-phone.en.vtt"), `WEBVTT\n\n${held.map((c) => `${stamp(c.start, ".")} --> ${stamp(c.end, ".")}\n${c.text}\n`).join("\n")}`);
  writeFileSync(join(outDir, "shahi-phone.en.srt"), held.map((c, i) => `${i + 1}\n${stamp(c.start, ",")} --> ${stamp(c.end, ",")}\n${c.text}\n`).join("\n"));
}

const dbfs = (x: number) => (x > 1e-6 ? (20 * Math.log10(x)).toFixed(1) : "-inf");
console.log(`${out}\n  ${sec(T.total)}s, ${SR} Hz stereo · ${d.lufs(master).toFixed(1)} LUFS · peak ${dbfs(d.peak(master))} dBFS`);

const stems = process.argv.indexOf("--stems");
if (stems > 0) {
  const dir = process.argv[stems + 1];
  if (!dir || dir.startsWith("--")) throw new Error("--stems needs a directory to write the stems to.");
  mkdirSync(dir, { recursive: true });
  let v2 = 0, m2 = 0;
  for (let i = 0; i < N; i++) {
    if (voEnv[i] <= voFull * 0.5) continue;
    v2 += vo.l[i] ** 2 + vo.r[i] ** 2;
    m2 += music.l[i] ** 2 + music.r[i] ** 2;
  }
  console.log(`  while the voice speaks, it stands ${(10 * Math.log10(v2 / m2)).toFixed(1)} dB over the music`);
  for (const [name, b] of Object.entries({ pads, bass: bassBus, drums, arp, fx, sfx, chimes, vo, music, master })) {
    const norm = d.stereo(N);
    d.mix(norm, b, 0.9 / (d.peak(b) || 1));
    writeFileSync(join(dir, `${name}.wav`), d.wav(norm, d.rng(2)));
  }
}
