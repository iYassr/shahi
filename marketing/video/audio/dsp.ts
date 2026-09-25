// A small synthesis kit for the launch soundtrack. Everything is rendered
// offline into Float32Arrays at 48 kHz; nothing here runs in the video.

export const SR = 48000;

export type Stereo = { l: Float32Array; r: Float32Array };
export const stereo = (n: number): Stereo => ({ l: new Float32Array(n), r: new Float32Array(n) });

export const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
export const db = (d: number) => 10 ** (d / 20);

/** Seeded PRNG (mulberry32): the same soundtrack on every run. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Adds a mono signal to a bus at `at` seconds, equal-power panned (-1 left … 1 right). */
export function place(bus: Stereo, sig: Float32Array, at: number, gain = 1, pan = 0) {
  const start = Math.round(at * SR);
  const a = ((pan + 1) * Math.PI) / 4;
  const gl = Math.cos(a) * gain, gr = Math.sin(a) * gain;
  for (let i = 0; i < sig.length; i++) {
    const j = start + i;
    if (j < 0 || j >= bus.l.length) continue;
    bus.l[j] += sig[i] * gl;
    bus.r[j] += sig[i] * gr;
  }
}

export function placeStereo(bus: Stereo, sig: Stereo, at: number, gain = 1) {
  const start = Math.round(at * SR);
  for (let i = 0; i < sig.l.length; i++) {
    const j = start + i;
    if (j < 0 || j >= bus.l.length) continue;
    bus.l[j] += sig.l[i] * gain;
    bus.r[j] += sig.r[i] * gain;
  }
}

export function mix(into: Stereo, from: Stereo, gain = 1) {
  for (let i = 0; i < into.l.length; i++) {
    into.l[i] += from.l[i] * gain;
    into.r[i] += from.r[i] * gain;
  }
}

/* --------------------------------------------------------------- filters */

/** RBJ biquad. `set` may be called per block to sweep. */
export class Biquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  set(type: "lp" | "hp" | "bp", f: number, q = 0.707) {
    const w = (2 * Math.PI * Math.min(Math.max(f, 10), SR * 0.45)) / SR;
    const cw = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
    let b0: number, b1: number, b2: number;
    if (type === "lp") { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; }
    else if (type === "hp") { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; }
    else { b0 = al; b1 = 0; b2 = -al; }
    return this.coefs(b0 / a0, b1 / a0, b2 / a0, (-2 * cw) / a0, (1 - al) / a0);
  }
  coefs(b0: number, b1: number, b2: number, a1: number, a2: number) {
    this.b0 = b0; this.b1 = b1; this.b2 = b2; this.a1 = a1; this.a2 = a2;
    return this;
  }
  run(x: number) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

/** Runs `sig` through a biquad whose cutoff follows `f(t)` (t in seconds), updated every 32 samples. */
export function sweep(sig: Float32Array, type: "lp" | "hp" | "bp", f: (t: number) => number, q = 0.707) {
  const bq = new Biquad();
  const out = new Float32Array(sig.length);
  for (let i = 0; i < sig.length; i++) {
    if (i % 32 === 0) bq.set(type, f(i / SR), q);
    out[i] = bq.run(sig[i]);
  }
  return out;
}

/* ----------------------------------------------------------- oscillators */

// PolyBLEP: a saw without the aliasing a naive ramp puts into the top octave.
const blep = (t: number, dt: number) => {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
};

export function noise(len: number, r: () => number) {
  const out = new Float32Array(Math.round(len * SR));
  for (let i = 0; i < out.length; i++) out[i] = r() * 2 - 1;
  return out;
}

/* ------------------------------------------------------------ instruments */

export type PadOpts = { cutoff: [number, number]; attack?: number; release?: number; seed?: number };

/**
 * A warm pad: three detuned saws per note spread across the field, through a
 * lowpass that moves from `cutoff[0]` to `cutoff[1]` over the chord.
 */
export function pad(notes: number[], dur: number, o: PadOpts): Stereo {
  const attack = o.attack ?? 0.5, release = o.release ?? 1.2, det = 0.09;
  const r = rng(o.seed ?? 1);
  const n = Math.round((dur + release) * SR);
  const out = stereo(n);
  const voices = notes.flatMap((m) => [-1, 0, 1].map((k) => ({ f: hz(m + k * det), pan: k * 0.7, ph: r() })));
  const g = 0.9 / Math.sqrt(voices.length);
  for (const v of voices) {
    const a = ((v.pan + 1) * Math.PI) / 4, gl = Math.cos(a) * g, gr = Math.sin(a) * g;
    let ph = v.ph;
    for (let i = 0; i < n; i++) {
      // A slow, per-voice pitch drift keeps a held chord alive.
      const f = v.f * (1 + 0.0012 * Math.sin((2 * Math.PI * i) / SR * 0.23 + v.ph * 6));
      const dt = f / SR;
      ph += dt; if (ph >= 1) ph -= 1;
      const s = 2 * ph - 1 - blep(ph, dt);
      out.l[i] += s * gl; out.r[i] += s * gr;
    }
  }
  const lp = (t: number) => o.cutoff[0] * (o.cutoff[1] / o.cutoff[0]) ** Math.min(1, t / dur);
  out.l = sweep(sweep(out.l, "lp", lp, 0.6), "lp", lp, 0.6);
  out.r = sweep(sweep(out.r, "lp", lp, 0.6), "lp", lp, 0.6);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = t < attack ? (t / attack) ** 1.5 : t < dur ? 1 : Math.exp((-(t - dur) * 4) / release);
    out.l[i] *= env; out.r[i] *= env;
  }
  return out;
}

/** A soft FM pluck: bright on the attack, round as it decays. */
export function pluck(midi: number, decay = 0.35, bright = 1) {
  const f = hz(midi), n = Math.round(decay * 5 * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const idx = bright * 2.2 * Math.exp(-t / 0.07);
    const env = Math.min(1, t / 0.002) * Math.exp(-t / decay);
    out[i] = Math.sin(2 * Math.PI * f * t + idx * Math.sin(2 * Math.PI * f * 2 * t)) * env;
  }
  return out;
}

/** A glassy bell: inharmonic FM with a long tail. */
export function bell(midi: number, decay = 1.1, bright = 1) {
  const f = hz(midi), n = Math.round(decay * 5 * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const idx = bright * 1.8 * Math.exp(-t / 0.25);
    const env = Math.min(1, t / 0.003) * Math.exp(-t / decay);
    out[i] = (Math.sin(2 * Math.PI * f * t + idx * Math.sin(2 * Math.PI * f * 3.5 * t)) + 0.25 * Math.sin(2 * Math.PI * f * 2 * t) * Math.exp(-t / 0.3)) * env * 0.8;
  }
  return out;
}

export function bass(midi: number, dur: number) {
  const f = hz(midi), n = Math.round((dur + 0.05) * SR);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += f / SR;
    const env = Math.min(1, t / 0.006) * (t < dur ? Math.exp(-t / 0.9) : Math.exp(-dur / 0.9) * Math.max(0, 1 - (t - dur) / 0.05));
    out[i] = (Math.sin(2 * Math.PI * ph) + 0.22 * Math.sin(4 * Math.PI * ph) + 0.08 * Math.sin(6 * Math.PI * ph)) * env;
  }
  return sweep(out, "lp", () => 900, 0.7);
}

export function kick(r: () => number) {
  const n = Math.round(0.5 * SR);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (46 + 90 * Math.exp(-t / 0.028)) / SR;
    out[i] = Math.sin(2 * Math.PI * ph) * Math.exp(-t / 0.2) + (r() * 2 - 1) * Math.exp(-t / 0.0012) * 0.25;
  }
  return out;
}

export function snap(r: () => number) {
  const n = Math.round(0.35 * SR);
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // Three quick bursts, as a hand clap is several hands' worth of impact.
    const burst = [0, 0.009, 0.018].reduce((s, o) => s + (t >= o ? Math.exp(-(t - o) / (o === 0.018 ? 0.07 : 0.006)) : 0), 0);
    raw[i] = (r() * 2 - 1) * burst;
  }
  return sweep(raw, "bp", () => 1700, 0.9);
}

export function hat(r: () => number, open = false) {
  const n = Math.round((open ? 0.4 : 0.08) * SR);
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) raw[i] = (r() * 2 - 1) * Math.exp(-(i / SR) / (open ? 0.12 : 0.018));
  return sweep(raw, "hp", () => 7500, 0.7);
}

/** A sub drop for the big moments, settling on `base` Hz so it lands in key. */
export function boom(r: () => number, len: number, base: number) {
  const n = Math.round(len * SR);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (base + 44 * Math.exp(-t / 0.18)) / SR;
    out[i] = Math.sin(2 * Math.PI * ph) * Math.min(1, t / 0.004) * Math.exp(-t / 0.55) + (r() * 2 - 1) * Math.exp(-t / 0.01) * 0.12;
  }
  return out;
}

/** Filtered noise that rises into a cut: `len` seconds, loudest at the end. */
export function riser(r: () => number, len: number) {
  const raw = noise(len, r);
  const out = sweep(raw, "bp", (t) => 300 * (7000 / 300) ** (t / len), 1.4);
  for (let i = 0; i < out.length; i++) out[i] *= ((i / out.length) ** 2.2);
  return out;
}

/** The air after a big hit: bright noise, long decay. */
export function air(r: () => number, len = 2.6) {
  const raw = noise(len, r);
  for (let i = 0; i < raw.length; i++) raw[i] *= Math.exp(-(i / SR) / 0.7);
  return sweep(raw, "hp", () => 4500, 0.6);
}

/* -------------------------------------------------------- sound effects */

/** One keystroke. `space`/`enter` are larger keys, lower and thicker. */
export function key(r: () => number, kind: "key" | "space" | "enter" = "key") {
  const n = Math.round(0.06 * SR);
  const out = new Float32Array(n);
  const bp = new Biquad().set("bp", kind === "key" ? 2400 + r() * 1400 : 1100 + r() * 300, 1.3);
  const thump = kind === "key" ? 170 + r() * 60 : 115;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let s = bp.run((r() * 2 - 1) * Math.exp(-t / 0.0022)) * 2.2 + Math.sin(2 * Math.PI * thump * t) * Math.exp(-t / 0.007) * 0.45;
    // A return key lands twice: the press, then the key bottoming out.
    if (kind === "enter" && t > 0.028) s += (r() * 2 - 1) * Math.exp(-(t - 0.028) / 0.002) * 0.35;
    out[i] = s * (kind === "key" ? 0.8 + r() * 0.35 : 1.15);
  }
  return out;
}

/** A finger on glass: a short, dull tock. Long enough for the tock to decay: cut at 80 ms it clicked. */
export function tap(r: () => number) {
  const n = Math.round(0.14 * SR);
  const out = new Float32Array(n);
  const bp = new Biquad().set("bp", 1300, 1);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    out[i] = Math.sin(2 * Math.PI * 290 * t) * Math.exp(-t / 0.018) + bp.run((r() * 2 - 1) * Math.exp(-t / 0.003)) * 0.9;
  }
  return out;
}

/** A message arriving: a warm bubble whose pitch rises from `lo` to `hi` Hz. */
export function pop(lo: number, hi: number, len = 0.16) {
  const n = Math.round(len * SR);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (lo * (hi / lo) ** Math.min(1, t / 0.045)) / SR;
    out[i] = Math.sin(2 * Math.PI * ph) * Math.min(1, t / 0.002) * Math.exp(-t / 0.045);
  }
  return out;
}

/** A short pitched confirmation, for ticks and steps. */
export function blip(midi: number, len = 0.25) {
  const f = hz(midi), n = Math.round(len * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    out[i] = (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(2 * Math.PI * f * 2 * t) * Math.exp(-t / 0.02)) * Math.min(1, t / 0.0015) * Math.exp(-t / 0.06);
  }
  return out;
}

/** Air moving past: noise through a band that rises and falls, panned from `from` to `to`. */
export function whoosh(r: () => number, len: number, from = -0.6, to = 0.6, peak = 2600): Stereo {
  const raw = noise(len, r);
  const band = sweep(raw, "bp", (t) => 260 + (peak - 260) * Math.sin((Math.PI * t) / len) ** 1.6, 0.8);
  const out = stereo(band.length);
  for (let i = 0; i < band.length; i++) {
    const u = i / band.length;
    const env = Math.sin(Math.PI * u) ** 2 * (1 - 0.5 * u);
    const a = ((from + (to - from) * u + 1) * Math.PI) / 4;
    out.l[i] = band[i] * env * Math.cos(a);
    out.r[i] = band[i] * env * Math.sin(a);
  }
  return out;
}

/* ----------------------------------------------------------- processors */

/** Freeverb (Jezar's tunings, rescaled to 48 kHz). */
export function reverb(input: Stereo, feedback = 0.84, damp = 0.28): Stereo {
  const scale = SR / 44100, spread = 23;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
  const alls = [556, 441, 341, 225];
  const run = (side: number) => {
    const cb = combs.map((c) => ({ buf: new Float32Array(Math.round((c + side * spread) * scale)), i: 0, store: 0 }));
    const ab = alls.map((a) => ({ buf: new Float32Array(Math.round((a + side * spread) * scale)), i: 0 }));
    const out = new Float32Array(input.l.length);
    for (let n = 0; n < out.length; n++) {
      const x = (input.l[n] + input.r[n]) * 0.015;
      let y = 0;
      for (const c of cb) {
        const o = c.buf[c.i];
        c.store = o * (1 - damp) + c.store * damp;
        c.buf[c.i] = x + c.store * feedback;
        if (++c.i >= c.buf.length) c.i = 0;
        y += o;
      }
      for (const a of ab) {
        const o = a.buf[a.i];
        a.buf[a.i] = y + o * 0.5;
        if (++a.i >= a.buf.length) a.i = 0;
        y = o - y;
      }
      out[n] = y;
    }
    return out;
  };
  return { l: run(0), r: run(1) };
}

/** Ping-pong delay, wet only: the first echo lands left, the next right, each darker than the last. */
export function delay(input: Stereo, time: number, feedback = 0.38, tone = 3500): Stereo {
  const d = Math.round(time * SR), n = input.l.length;
  const out = stereo(n);
  const lpL = new Biquad().set("lp", tone), lpR = new Biquad().set("lp", tone);
  for (let i = d; i < n; i++) {
    out.l[i] = lpL.run((input.l[i - d] + input.r[i - d]) * 0.5 + out.r[i - d] * feedback);
    out.r[i] = lpR.run(out.l[i - d] * feedback);
  }
  return out;
}

/** A feed-forward compressor for one voice: above `threshold` (dBFS) the level rises 1/`ratio` as fast. */
export function compress(sig: Float32Array, threshold: number, ratio: number, attack = 0.005, release = 0.12) {
  const out = new Float32Array(sig.length);
  const ka = Math.exp(-1 / (attack * SR)), kr = Math.exp(-1 / (release * SR));
  let e = 0;
  for (let i = 0; i < sig.length; i++) {
    const x = Math.abs(sig[i]);
    e = x > e ? ka * e + (1 - ka) * x : kr * e + (1 - kr) * x;
    const over = 20 * Math.log10(Math.max(e, 1e-9)) - threshold;
    out[i] = sig[i] * (over > 0 ? db(-over * (1 - 1 / ratio)) : 1);
  }
  return out;
}

/** Holds a level curve at its highest value over the last `time` seconds, so a duck stays down through the gaps between words. */
export function hold(env: Float32Array, time: number) {
  const L = Math.round(time * SR), out = new Float32Array(env.length), dq = new Int32Array(env.length);
  let h = 0, t = 0;
  for (let i = 0; i < env.length; i++) {
    while (t > h && env[dq[t - 1]] <= env[i]) t--;
    dq[t++] = i;
    while (dq[h] < i - L) h++;
    out[i] = env[dq[h]];
  }
  return out;
}

/** Multiplies a bus by a gain curve. */
export function applyGain(bus: Stereo, g: Float32Array) {
  for (let i = 0; i < bus.l.length; i++) { bus.l[i] *= g[i]; bus.r[i] *= g[i]; }
}

/** A smoothed level follower (attack/release in seconds) of a stereo bus. */
export function follow(bus: Stereo, attack = 0.005, release = 0.25) {
  const out = new Float32Array(bus.l.length);
  const ka = Math.exp(-1 / (attack * SR)), kr = Math.exp(-1 / (release * SR));
  let e = 0;
  for (let i = 0; i < out.length; i++) {
    const x = Math.max(Math.abs(bus.l[i]), Math.abs(bus.r[i]));
    e = x > e ? ka * e + (1 - ka) * x : kr * e + (1 - kr) * x;
    out[i] = e;
  }
  return out;
}

/**
 * A lookahead peak limiter: the gain is already down when a peak arrives, and
 * recovers over `release`. The min-filter spans ±`look` and the box average is
 * narrower than it, so the gain at any peak is at or below what that peak needs.
 */
export function limit(bus: Stereo, ceiling: number, look = 0.004, release = 0.08) {
  const n = bus.l.length, L = Math.round(look * SR);
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = Math.max(Math.abs(bus.l[i]), Math.abs(bus.r[i]));
    need[i] = p > ceiling ? ceiling / p : 1;
  }
  // Sliding-window minimum over [i-L, i+L] with a monotonic deque.
  const mins = new Float32Array(n);
  const dq = new Int32Array(n);
  let h = 0, t = 0;
  for (let j = 0; j < n + L; j++) {
    if (j < n) {
      while (t > h && need[dq[t - 1]] >= need[j]) t--;
      dq[t++] = j;
    }
    const i = j - L;
    if (i >= 0) {
      while (dq[h] < i - L) h++;
      mins[i] = need[dq[h]];
    }
  }
  // A box average no wider than the min-filter keeps the gain at or below what
  // every peak needs, while turning its steps into short ramps.
  const half = Math.max(1, Math.floor(L / 2));
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + mins[i];
  const kr = Math.exp(-1 / (release * SR));
  let g = 1;
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half), hi = Math.min(n, i + half + 1);
    const box = (pre[hi] - pre[lo]) / (hi - lo);
    g = box < g ? box : kr * g + (1 - kr) * box;
    bus.l[i] *= g; bus.r[i] *= g;
  }
}

/** Integrated loudness per ITU-R BS.1770-4 (LUFS), with the 48 kHz K-weighting coefficients. */
export function lufs(bus: Stereo) {
  const kw = (x: Float32Array) => {
    const a = new Biquad().coefs(1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585);
    const b = new Biquad().coefs(1, -2, 1, -1.99004745483398, 0.99007225036621);
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) y[i] = b.run(a.run(x[i]));
    return y;
  };
  const l = kw(bus.l), r = kw(bus.r);
  const block = Math.round(0.4 * SR), step = Math.round(0.1 * SR);
  const z: number[] = [];
  for (let s = 0; s + block <= l.length; s += step) {
    let sum = 0;
    for (let i = s; i < s + block; i++) sum += l[i] * l[i] + r[i] * r[i];
    z.push(sum / block);
  }
  const ld = (m: number) => -0.691 + 10 * Math.log10(m);
  const abs = z.filter((m) => ld(m) > -70);
  const rel = ld(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const gated = abs.filter((m) => ld(m) > rel);
  return ld(gated.reduce((a, b) => a + b, 0) / gated.length);
}

export function peak(bus: Stereo) {
  let p = 0;
  for (let i = 0; i < bus.l.length; i++) p = Math.max(p, Math.abs(bus.l[i]), Math.abs(bus.r[i]));
  return p;
}

/** 16-bit PCM WAV with TPDF dither. */
export function wav(bus: Stereo, r: () => number) {
  const n = bus.l.length, data = n * 4;
  const buf = new ArrayBuffer(44 + data);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + data, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, SR, true); v.setUint32(28, SR * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, data, true);
  for (let i = 0; i < n; i++) {
    for (const [k, ch] of [bus.l, bus.r].entries()) {
      const s = Math.round(ch[i] * 32767 + (r() - r()));
      v.setInt16(44 + i * 4 + k * 2, Math.max(-32768, Math.min(32767, s)), true);
    }
  }
  return new Uint8Array(buf);
}
