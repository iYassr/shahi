import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

/**
 * Decodes an audio file to mono float samples at `sr` with the ffmpeg Remotion
 * ships, so nothing else needs installing. That build writes no raw float
 * stream, only WAV, and a piped WAV's size fields are placeholders: read the
 * data chunk to the end.
 */
export function decode(file: string, sr: number) {
  const p = spawnSync("npx", ["remotion", "ffmpeg", "-v", "error", "-i", file, "-ac", "1", "-ar", String(sr), "-c:a", "pcm_s24le", "-f", "wav", "pipe:1"], { cwd: ROOT, maxBuffer: 1 << 28 });
  if (p.status !== 0) throw new Error(`ffmpeg could not decode ${file}: ${p.stderr.toString()}`);
  const b = new Uint8Array(p.stdout);
  let o = 12;
  while (o + 8 <= b.length && String.fromCharCode(...b.subarray(o, o + 4)) !== "data") o += 8 + (b[o + 4] | (b[o + 5] << 8) | (b[o + 6] << 16) | (b[o + 7] << 24));
  o += 8;
  const out = new Float32Array(Math.floor((b.length - o) / 3));
  for (let i = 0; i < out.length; i++) {
    const v = b[o + i * 3] | (b[o + i * 3 + 1] << 8) | (b[o + i * 3 + 2] << 16);
    out[i] = ((v << 8) >> 8) / 8388608;
  }
  return out;
}

/**
 * The level of a take's last 10 ms against its peak, in dB. eleven_v3 sometimes
 * stops a take mid-sound: measured at -12 to -28 dB on clipped takes ("Live!"
 * lost its vowel), -83 to -88 dB on clean ones.
 */
export function tailDb(x: Float32Array, sr: number) {
  let pk = 0;
  for (const s of x) pk = Math.max(pk, Math.abs(s));
  const n = Math.round(sr / 100);
  let e = 0;
  for (let i = x.length - n; i < x.length; i++) e += x[i] * x[i];
  return 10 * Math.log10(e / n / (pk * pk) + 1e-12);
}

/** Speech runs in a take, in seconds: 10 ms frames within 45 dB of the loudest, split where 60 ms or more falls below that. */
export function speechRuns(x: Float32Array, sr: number): [number, number][] {
  const hop = Math.round(sr / 100), n = Math.floor(x.length / hop);
  const rms = new Float32Array(n);
  let top = 0;
  for (let f = 0; f < n; f++) {
    let e = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) e += x[i] * x[i];
    rms[f] = Math.sqrt(e / hop);
    top = Math.max(top, rms[f]);
  }
  const thr = top * 10 ** (-45 / 20), runs: [number, number][] = [];
  let from = -1, quiet = 0;
  for (let f = 0; f < n; f++) {
    if (rms[f] >= thr) { if (from < 0) from = f; quiet = 0; }
    else if (from >= 0 && ++quiet >= 6) { runs.push([(from * hop) / sr, ((f - quiet + 1) * hop) / sr]); from = -1; quiet = 0; }
  }
  if (from >= 0) runs.push([(from * hop) / sr, ((n - quiet) * hop) / sr]);
  return runs;
}

/** A take is clean when it ends this far under its peak: well clear of both measured groups. */
export const CLEAN_TAIL_DB = -45;
