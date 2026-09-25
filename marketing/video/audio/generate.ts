// Renders the launch cut's soundtrack, voice-over, music and sound effects in
// one mixed stereo WAV, from the same timeline the picture reads
// (src/launch/timeline.ts), and the voice-over's captions.
//
//   bun audio/generate.ts                  → public/audio/launch.wav, out/shahi-launch.en.{vtt,srt}
//   bun audio/generate.ts --stems <dir>    … and each bus beside it, for checking the balance
//
// Deterministic: seeded noise, no randomness at run time, the same bytes every run.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BEAT, CHAT, END, HERDR, HOOK, keyFrame, PROBLEM, sec, SETUP, T } from "../src/launch/timeline";
import { CLEAN_TAIL_DB, decode, speechRuns, tailDb } from "./decode";
import * as d from "./dsp";
import { speak } from "./voiceover";

const { SR } = d;
const N = Math.round(sec(T.total) * SR);
const r = d.rng(20260925);

const BAR = 4 * BEAT;
/** The frame bar `k` starts on, counted from the first cut; the hook is the pickup before bar 0. */
const barAt = (k: number) => T.problem + k * BAR;

const bus = () => d.stereo(N);
const pads = bus(), bassBus = bus(), drums = bus(), arp = bus(), fx = bus();
// Effects in three buses, because they give way to the voice differently:
// keys, taps and whooshes are short and stay nearly full; pitched chimes (pops,
// blips, bells, plucks) ring through words and duck as far as the music; the
// hook's hits are one-off punctuation, outside the music's duck.
const sfx = bus(), chimes = bus(), hits = bus();
const verb = bus(), sfxVerb = bus(), hitsVerb = bus(), echo = bus();

/* ------------------------------------------------------------- harmony */

// B minor into D major: the problem sits on unresolved chords, setup and the
// chat move through D, herdr climbs Em to A, and the end card resolves on D
// with an added ninth (IV–ii–V–I across the last three cuts).
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
type Section = { from: number; to: number; chords: Chord[]; cutoff: [number, number]; groove: Groove; arp: 0 | 8 | 16; bar: number };

/**
 * A section of music spanning two cuts, one chord per bar. Its bars come from
 * the cuts, so moving a cut in timeline.ts moves the music with it, and a cut
 * that leaves the bar grid, or a chord list that no longer fills the section,
 * stops the build instead of drifting against the picture.
 */
const section = (from: number, to: number, chords: Chord[], cutoff: [number, number], groove: Groove, arp: 0 | 8 | 16): Section => {
  const bar = (from - T.problem) / BAR, bars = (to - from) / BAR;
  if (!Number.isInteger(bar) || !Number.isInteger(bars)) throw new Error(`The cuts at frames ${from} and ${to} are not on bar lines (every ${BAR} frames from ${T.problem}).`);
  if (bars !== chords.length) throw new Error(`The section from frame ${from} is ${bars} bars long but has ${chords.length} chords.`);
  return { from, to, chords, cutoff, groove, arp, bar };
};
const sections: Section[] = [
  section(T.problem, T.setup, [Gmaj7, Em, Fsus], [650, 1000], "tick", 0),
  section(T.setup, T.chat, [D, AoverCs, Bm], [1100, 2600], "half", 8),
  section(T.chat, T.herdr, [D, A, Bm, G], [2600, 3400], "full", 16),
  section(T.herdr, T.end, [Em, A], [3400, 5000], "drive", 16),
];

const barSec = sec(BAR), beatSec = sec(BEAT);
const kicks: number[] = [];

// The hook: a dark pad and a low drone under the two lines, a bell and a drop
// on "Your agents didn't.", and a rise into the first cut.
d.placeStereo(pads, d.pad(Bm.pad.slice(0, 4), sec(barAt(0)) + 0.1, { cutoff: [350, 750], attack: 1.4, release: 0.9, seed: 1 }), 0, 0.38);
d.place(bassBus, d.bass(35, sec(barAt(0)) - 0.2), 0.25, 0.22);
{
  const pl = d.pluck(59, 0.6, 0.6);
  d.place(arp, pl, sec(HOOK.line1At), 0.12, -0.2);
  d.place(verb, pl, sec(HOOK.line1At), 0.3, -0.2);
}
// The drop and bells are hits, not bed: they sit outside the music's duck,
// which took them down 15 dB in the pause before "Your agents didn't."
d.place(hits, d.boom(r, 1.4, d.hz(23)), sec(HOOK.line2At), 0.55);
for (const [m, dt, p] of [[71, 0, -0.3], [78, 0.07, 0.3]] as const) {
  // Soft FM: brighter, the bell's strongest overtone was an A# over B minor.
  const b = d.bell(m, 1.6, 0.4);
  d.place(hits, b, sec(HOOK.line2At) + dt, 0.1, p);
  d.place(hitsVerb, b, sec(HOOK.line2At) + dt, 0.35, p);
}
d.place(fx, d.riser(r, sec(barAt(0) - 55)), sec(55), 0.16);

for (const s of sections) {
  s.chords.forEach((c, i) => {
    const at = sec(barAt(s.bar + i));
    const span = s.chords.length;
    const lo = s.cutoff[0] * (s.cutoff[1] / s.cutoff[0]) ** (i / span);
    const hi = s.cutoff[0] * (s.cutoff[1] / s.cutoff[0]) ** ((i + 1) / span);
    const p = d.pad(c.pad, barSec, { cutoff: [lo, hi], attack: 0.18, release: 0.7, seed: 10 + s.bar + i });
    d.placeStereo(pads, p, at, s.groove === "tick" ? 0.34 : 0.3);
    d.placeStereo(verb, p, at, 0.12);

    for (let b = 0; b < 4; b++) {
      const t = at + b * beatSec;
      const last = s === sections[sections.length - 1] && i === span - 1;
      if (s.groove === "tick") {
        // The problem's pulse: a quiet clock on the eighths and a low heartbeat.
        for (const e of [0, 0.5]) d.place(drums, d.hat(r), t + e * beatSec, e === 0 ? 0.2 : 0.13, 0.3);
        if (b === 0 || b === 2) {
          d.place(bassBus, d.bass(c.bass, 0.35), t, 0.35);
          // Two octaves up, the heartbeat survives a phone or laptop speaker,
          // which reproduces nothing of the 41-49 Hz fundamentals.
          d.place(bassBus, d.bass(c.bass + 24, 0.35), t, 0.22);
        }
        continue;
      }
      const kickHere = s.groove === "drive" || b === 0 || b === 2;
      if (kickHere) { d.place(drums, d.kick(r), t, 0.62); kicks.push(t); }
      if (s.groove === "full" && b === 2) { d.place(drums, d.kick(r), t + 0.5 * beatSec, 0.28); kicks.push(t + 0.5 * beatSec); }
      if ((s.groove === "full" || s.groove === "drive") && (b === 1 || b === 3) && !(last && b === 3)) {
        const sn = d.snap(r);
        d.place(drums, sn, t, 0.3, 0.05);
        d.place(verb, sn, t, 0.25, 0.05);
      }
      const steps = s.groove === "half" ? 2 : 4;
      for (let k = 0; k < steps; k++) {
        const accent = k % 2 === 0 ? 1 : 0.6;
        d.place(drums, d.hat(r, s.groove === "full" && b === 3 && k === 2), t + (k / steps) * beatSec, (s.groove === "half" ? 0.06 : 0.07) * accent, 0.35);
      }
      // Bass on the eighths, with an octave lift on the offbeat once the chat starts.
      for (const e of [0, 0.5]) {
        const up = s.groove !== "half" && e === 0.5 && b % 2 === 1 ? 12 : 0;
        d.place(bassBus, d.bass(c.bass + up, beatSec * 0.42), t + e * beatSec, 0.32);
      }
      // A snare roll into the end card, 16ths, rising.
      if (last && b === 3) {
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

// The herdr section rises into the end card.
d.place(fx, d.riser(r, sec(T.end - T.herdr)), sec(T.herdr), 0.14);

// The end card: one wide chord that settles, a drop, and air.
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
  d.place(arp, d.pluck(62, 0.9, 0.5), sec(END.cmd), 0.12);
  d.place(echo, d.pluck(62, 0.9, 0.5), sec(END.cmd), 0.12);
}

/* ------------------------------------------------------- sound effects */

const typeKeys = (text: string, start: number, cps: number, gain: number, pan: number) => {
  [...text].forEach((c, k) => {
    d.place(sfx, d.key(r, c === " " ? "space" : "key"), sec(keyFrame(start, cps, k + 1)), gain, pan + (r() - 0.5) * 0.1);
  });
};
const whooshAt = (frame: number, len = 0.6, from = -0.5, to = 0.6, g = 0.3) => d.placeStereo(sfx, d.whoosh(r, len, from, to), sec(frame), g);
// Bells ring over the voice, so they are short and mostly dry: with a 0.9 s
// decay and a reverb send louder than the bell, their tails covered words.
const bells = (notes: [number, number][], frame: number, g: number, pan: number, decay: number) => {
  for (const [m, dt] of notes) {
    const b = d.bell(m, decay);
    d.place(chimes, b, sec(frame) + dt, g, pan);
    d.place(sfxVerb, b, sec(frame) + dt, g * 0.5, pan);
  }
};

// Problem: the phone arrives; the thumb pans the wide terminal, pinches, pans back.
whooshAt(T.problem - 6, 0.65, 0.7, 0.2);
whooshAt(PROBLEM.panOut, 0.55, 0.5, -0.1, 0.12);
d.place(sfx, d.tap(r), sec(PROBLEM.pinch - 4), 0.18, 0.2);
d.place(sfx, d.tap(r), sec(PROBLEM.pinch - 3), 0.16, 0.5);
whooshAt(PROBLEM.panBack, 0.45, -0.1, 0.5, 0.1);

// Setup: two commands typed and entered, the code, the tap, the scan, connected.
whooshAt(T.setup - 4, 0.6, -0.6, 0.4);
typeKeys(SETUP.cmd1, SETUP.cmd1At, SETUP.cmd1Cps, 0.22, -0.1);
d.place(sfx, d.key(r, "enter"), sec(SETUP.cmd1Enter), 0.3, -0.1);
d.place(chimes, d.blip(81, 0.2), sec(SETUP.installed), 0.12, -0.1);
typeKeys(SETUP.cmd2, SETUP.cmd2At, SETUP.cmd2Cps, 0.22, -0.1);
d.place(sfx, d.key(r, "enter"), sec(SETUP.cmd2Enter), 0.3, -0.1);
// Pops land on a note of the chord under them: a pop glides up to a held pitch,
// and three of the four unpitched ones clashed with the chat's chords.
const popOn = (m: number, len?: number) => d.pop(d.hz(m) / 1.83, d.hz(m), len);
d.place(chimes, popOn(73, 0.2), sec(SETUP.popup), 0.3, -0.05);
d.place(sfx, d.tap(r), sec(SETUP.tap), 0.34, 0.45);
d.placeStereo(sfx, d.whoosh(r, 0.3, 0.3, 0.6, 1600), sec(SETUP.tap + 6), 0.14);
d.place(sfx, d.key(r), sec(SETUP.locked), 0.2, 0.45);
d.place(sfx, d.key(r), sec(SETUP.locked + 3), 0.16, 0.45);
bells([[86, 0], [93, 0.09]], SETUP.done, 0.2, 0.4, 0.35);

// Chat: messages arrive, a prompt asks, a tap answers, a reply is typed and sent.
whooshAt(T.chat - 6, 0.6, -0.4, 0.5);
d.place(chimes, popOn(81), sec(CHAT.you), 0.26, 0.3);
d.place(chimes, popOn(78), sec(CHAT.agent), 0.28, 0.3);
d.place(chimes, d.blip(81, 0.15), sec(CHAT.tool), 0.08, 0.3);
d.place(chimes, d.blip(86, 0.2), sec(CHAT.toolDone), 0.12, 0.3);
d.place(chimes, d.blip(78, 0.15), sec(CHAT.edit), 0.08, 0.3);
bells([[81, 0], [88, 0.11]], CHAT.prompt, 0.15, 0.3, 0.3);
d.place(sfx, d.tap(r), sec(CHAT.tapYes), 0.36, 0.25);
bells([[86, 0], [90, 0.05]], CHAT.answered, 0.17, 0.3, 0.4);
d.place(chimes, popOn(78), sec(CHAT.agentDone), 0.28, 0.3);
typeKeys(CHAT.reply, CHAT.typeAt, CHAT.typeCps, 0.2, 0.3);
d.place(sfx, d.tap(r), sec(CHAT.send), 0.34, 0.45);
d.placeStereo(sfx, d.whoosh(r, 0.28, 0.1, 0.7, 3600), sec(CHAT.send + 1), 0.16);
d.place(chimes, popOn(86), sec(CHAT.sent), 0.24, 0.3);

// herdr: each row lands on the phone as a note of the chord under it.
whooshAt(T.herdr - 6, 0.6, 0.5, -0.3);
HERDR.rows.forEach((frame, i) => {
  const note = [76, 79, 83, 85][i]; // E minor's E G B, then A major's C# as the bar changes
  const pl = d.pluck(note, 0.45, 1);
  d.place(chimes, pl, sec(frame), 0.14, 0.45);
  d.place(sfxVerb, pl, sec(frame), 0.1, 0.45);
});

// End: a shimmer on the mark, then the three promises tick up the chord.
bells([[86, 0], [93, 0.05], [98, 0.1]], END.mark, 0.09, 0, 0.6);
END.chips.forEach((frame, i) => d.place(chimes, d.blip([86, 90, 93][i], 0.3), sec(frame), 0.13, (i - 1) * 0.3));

/* ---------------------------------------------------------- voice-over */

const ROOT = join(import.meta.dirname, "..");

const spoken = await speak();
const vo = bus();
const cues: { start: number; end: number; text: string; by: number }[] = [];

/**
 * Caption times from the waveform. The alignment decides which pause separates
 * two sentences, the waveform where speech actually starts and stops: v3's
 * alignment gives each pause to the word after it, which put captions up to
 * half a second ahead of the voice, and gives a direction tag the first word's
 * time, which put them a quarter-second behind it.
 */
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
    // A sentence run into the next with no audible pause keeps its aligned times.
    if (best > 0 && dist < 0.35) { out[k].start = runs[best][0]; out[k - 1].end = runs[best - 1][1]; last = best; }
  }
  return out;
}

// Lines are placed by their audible sound, read from the waveform: v3 performs
// its direction (a sigh before the first word) outside the word timings, and a
// line placed by its first word put the sigh into the previous scene.
const fitted = spoken.map((sp) => {
  const raw = decode(sp.mp3, SR).slice(0, Math.round(sp.cut * SR));
  const tail = tailDb(raw, SR);
  if (tail >= CLEAN_TAIL_DB) throw new Error(`The "${sp.line.id}" take stops mid-sound (its last 10 ms are ${tail.toFixed(1)} dB under its peak); delete it from audio/vo/ to speak it again.`);
  // A 20 ms raised-cosine fade backs up the check: a take's last sample is never a step.
  const fade = Math.round(0.02 * SR);
  for (let i = 0; i < fade; i++) raw[raw.length - fade + i] *= 0.5 + 0.5 * Math.cos((Math.PI * i) / fade);
  const thr = d.peak({ l: raw, r: raw }) * 0.02; // -34 dB under the peak: breath and sigh count, room tone does not
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
  // Each line at the same loudness, so no sentence jumps out of the read.
  // A 3:1 compressor lifts the quieter syllables toward the stressed ones, so
  // the read holds its level against the music without the limiter taking peaks.
  const hp = d.sweep(raw, "hp", () => 75, 0.7);
  const clip = d.compress(hp, 20 * Math.log10(d.peak({ l: hp, r: hp })) - 14, 3);
  const mono = { l: clip, r: clip };
  const g = d.db(-16 - d.lufs(mono));
  d.place(vo, clip, at, g * Math.SQRT2); // centre pan is -3 dB per side; this restores the measured level
  for (const s of captionTimes(raw, sp.sentences)) cues.push({ start: at + s.start, end: at + s.end, text: s.text, by: sec(sp.line.by) });
}

/* ----------------------------------------------------------------- mix */

// The pads and bass make room for each kick, so the pulse reads without being loud.
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

// Effects sit 6 dB above where they were placed: measured against the music,
// their peaks were 6-10 dB under its average level, so a click or a tap was lost.
const SFX_GAIN = d.db(6);
const effects = bus();
d.mix(effects, sfx, SFX_GAIN);
d.mix(effects, chimes, SFX_GAIN);

// The music steps back while an effect speaks, and much further while the
// voice does: about 15 dB under speech, as a narrated spot sits, so every word
// is clear on a phone speaker. A 250 ms hold keeps it down between words; with
// release alone the bed swelled in every pause and breathed.
const env = d.follow(effects, 0.004, 0.22);
const voEnv = d.hold(d.follow(vo, 0.03, 0.45), 0.25);
// Speech sits 15-20 dB under its own peaks, so the duck keys on any speech at
// all rather than on loud speech: keyed at a fifth of the peak, the music only
// dipped part-way and the voice stood just 3 dB above it.
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
d.applyGain(hits, light);
// The chimes' reverb ducks with them: undipped, it carried about half the
// energy that covered words in the chat.
const chimesVerb = d.reverb(sfxVerb, 0.82, 0.35);
d.applyGain(chimesVerb, deep);

const master = bus();
d.mix(master, music);
d.mix(master, sfx, SFX_GAIN);
d.mix(master, chimes, SFX_GAIN);
d.mix(master, chimesVerb, 0.8 * SFX_GAIN);
d.mix(master, hits);
d.mix(master, d.reverb(hitsVerb, 0.86, 0.3), 0.9);
d.mix(master, vo);

// Fade out with the picture's last 12 frames of black.
const fadeFrom = Math.round(sec(T.total - 12) * SR);
for (let i = fadeFrom; i < N; i++) {
  const g = Math.cos(((i - fadeFrom) / (N - fadeFrom)) * (Math.PI / 2)) ** 2;
  master.l[i] *= g; master.r[i] *= g;
}

// Social feeds normalise loudness; -15 LUFS integrated with a -1.5 dBFS ceiling
// leaves headroom for the AAC encode's inter-sample peaks.
const TARGET = -15, CEILING = d.db(-1.5);
let makeup = 1;
for (let pass = 0; pass < 3; pass++) {
  const g = d.db(TARGET - d.lufs(master));
  makeup *= g;
  for (let i = 0; i < N; i++) { master.l[i] *= g; master.r[i] *= g; }
  d.limit(master, CEILING);
}

const out = join(ROOT, "public/audio/launch.wav");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, d.wav(master, d.rng(1)));

// Captions for the voice-over: WebVTT for the website's <track>, SRT for LinkedIn's upload.
{
  const stamp = (t: number, sep: string) => {
    const ms = Math.round(t * 1000);
    const hh = String(Math.floor(ms / 3600000)).padStart(2, "0"), mm = String(Math.floor(ms / 60000) % 60).padStart(2, "0");
    const ss = String(Math.floor(ms / 1000) % 60).padStart(2, "0"), mmm = String(ms % 1000).padStart(3, "0");
    return `${hh}:${mm}:${ss}${sep}${mmm}`;
  };
  // Hold each caption a moment past its last word, but never over the next one or past its scene's cut.
  const held = cues.map((c, i) => ({ ...c, end: Math.min(c.end + 0.35, cues[i + 1]?.start ?? sec(T.total), c.by) }));
  const outDir = join(ROOT, "out");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "shahi-launch.en.vtt"), `WEBVTT\n\n${held.map((c) => `${stamp(c.start, ".")} --> ${stamp(c.end, ".")}\n${c.text}\n`).join("\n")}`);
  writeFileSync(join(outDir, "shahi-launch.en.srt"), held.map((c, i) => `${i + 1}\n${stamp(c.start, ",")} --> ${stamp(c.end, ",")}\n${c.text}\n`).join("\n"));
}

const dbfs = (x: number) => (x > 1e-6 ? (20 * Math.log10(x)).toFixed(1) : "-inf");
console.log(`${out}\n  ${sec(T.total)}s, ${SR} Hz stereo · ${d.lufs(master).toFixed(1)} LUFS · peak ${dbfs(d.peak(master))} dBFS`);

// --stems: each bus as its own WAV (peak-normalised, for listening), and a
// table of each bus's level per section as it sits in the final mix.
const stems = process.argv.indexOf("--stems");
if (stems > 0) {
  const dir = process.argv[stems + 1];
  if (!dir || dir.startsWith("--")) throw new Error("--stems needs a directory to write the stems to.");
  mkdirSync(dir, { recursive: true });
  const all: Record<string, d.Stereo> = { pads, bass: bassBus, drums, arp, fx, sfx, chimes, hits, vo, music, master };
  const spans: [string, number, number][] = [["hook", T.hook, T.problem], ["problem", T.problem, T.setup], ["setup", T.setup, T.chat], ["chat", T.chat, T.herdr], ["herdr", T.herdr, T.end], ["end", T.end, T.total]];
  const rms = (b: d.Stereo, from: number, to: number) => {
    let sum = 0;
    const a = Math.round(sec(from) * SR), z = Math.round(sec(to) * SR);
    for (let i = a; i < z; i++) sum += b.l[i] * b.l[i] + b.r[i] * b.r[i];
    return Math.sqrt(sum / (2 * (z - a)));
  };
  const pk = (b: d.Stereo, from: number, to: number) => {
    let p = 0;
    for (let i = Math.round(sec(from) * SR); i < Math.round(sec(to) * SR); i++) p = Math.max(p, Math.abs(b.l[i]), Math.abs(b.r[i]));
    return p;
  };
  // How far the voice stands above the (ducked) music while it speaks, the number
  // that decides whether words are clear on a phone speaker.
  let v2 = 0, m2 = 0, e2 = 0;
  for (let i = 0; i < N; i++) {
    if (voEnv[i] <= voFull * 0.5) continue;
    v2 += vo.l[i] ** 2 + vo.r[i] ** 2;
    m2 += music.l[i] ** 2 + music.r[i] ** 2;
    const el = (sfx.l[i] + chimes.l[i]) * SFX_GAIN + hits.l[i], er = (sfx.r[i] + chimes.r[i]) * SFX_GAIN + hits.r[i];
    e2 += (music.l[i] + el) ** 2 + (music.r[i] + er) ** 2;
  }
  console.log(`  while the voice speaks, it stands ${(10 * Math.log10(v2 / m2)).toFixed(1)} dB over the music and ${(10 * Math.log10(v2 / e2)).toFixed(1)} dB over music and effects together`);
  console.log(`  RMS/peak dBFS as each bus reaches the master (pads to fx before the music duck, music after it):\n  ${"bus".padEnd(8)}${spans.map(([n]) => n.padStart(13)).join("")}`);
  for (const [name, b] of Object.entries(all)) {
    const g = name === "master" ? 1 : name === "sfx" || name === "chimes" ? makeup * SFX_GAIN : makeup;
    console.log(`  ${name.padEnd(8)}${spans.map(([, a, z]) => `${dbfs(rms(b, a, z) * g)}/${dbfs(pk(b, a, z) * g)}`.padStart(13)).join("")}`);
    const p = d.peak(b) || 1;
    const norm = d.stereo(N);
    d.mix(norm, b, 0.9 / p);
    writeFileSync(join(dir, `${name}.wav`), d.wav(norm, d.rng(2)));
  }
}
