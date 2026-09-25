// The launch cut's voice-over: the script, where each line starts, and the
// ElevenLabs call that speaks it.
//
// Speech is cached in audio/vo/ under a hash of the voice, model, settings and
// words, so a render never needs the API key; changing a line re-speaks only
// that line. To re-speak everything, for example after moving to a plan whose
// licence covers commercial use, delete audio/vo/ and run
// `ELEVENLABS_API_KEY=… bun run sound`.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { T } from "../src/launch/timeline";
import { CLEAN_TAIL_DB, decode, speechRuns, tailDb } from "./decode";

export const VOICE = {
  id: "JBFqnCBsd6RMkjVDRZzb", // George: warm, British, a storyteller's pace
  // v3 reads bracketed direction ([excited], [sighs]) as performance, not
  // words: the read gets the lift and the sigh a person would give it, where
  // multilingual v2 read every line in the same even voice.
  model: "eleven_v3",
  settings: { stability: 0.5, similarity_boost: 0.75 },
  /**
   * The first seed tried. v3 sometimes stops a take mid-word, and no wording
   * prevents it (an ellipsis fixed one line on one seed and failed on another),
   * so seeds are tried in order and the first take that ends in silence is kept.
   * The chosen seed is stored beside the take; seeds keep takes close to
   * repeatable, which ElevenLabs does not guarantee.
   */
  seed: 1170,
  attempts: 8,
  /**
   * Said after every line and cut away. v3 ends its audio where its text ends,
   * often inside the last sound: eight seeds of the hook all clipped the "t" of
   * "didn't". With a pause and a throwaway word after it, the line's last word
   * is never the take's, and the take is cut in the silence between them.
   */
  tail: " [long pause] Right.",
  /** Not in the cache key: takes are stored as .mp3, so changing this means deleting audio/vo/. */
  format: "mp3_44100_128",
};

export type Line = {
  id: string;
  /** Frame the line's first sound (a sigh, or the first word) starts on. */
  at: number;
  /** Frame by which its last sound must have ended: the next cut, or the fade to black. */
  by: number;
  /** What the captions say. */
  text: string;
  /**
   * What the voice is asked to say: the caption with its direction in brackets,
   * herdr spelled "herder" so it is said right, and "!" where the read should lift.
   */
  say?: string;
};

export const LINES: Line[] = [
  { id: "hook", at: T.hook + 4, by: T.problem, text: "You left your desk. Your agents didn't.", say: "[mischievously] You left your desk. Your agents didn't." },
  // Commas, not full stops: the three words keep their rhythm without a pause
  // after each, which ran this line past its cut.
  { id: "problem", at: T.problem + 4, by: T.setup, text: "A terminal on a phone? Pinch, scroll, squint.", say: "[sighs] A terminal on a phone? Pinch, scroll, squint." },
  {
    id: "setup",
    at: T.setup + 6,
    by: T.chat,
    text: "Shahi connects your phone to herdr in about a minute. Two commands. One scan.",
    say: "[excited] Shahi connects your phone to herder in about a minute. Two commands. One scan.",
  },
  {
    id: "chat",
    at: T.chat + 6,
    by: T.herdr,
    text: "Your agents become a chat. Read what they did, answer with a tap, and keep them moving.",
    say: "[happy] Your agents become a chat. Read what they did, answer with a tap, and keep them moving.",
  },
  { id: "herdr", at: T.herdr + 2, by: T.end, text: "Every space. Every pane. Live.", say: "[excited] Every space. Every pane. Live!" },
  { id: "end", at: T.end + 12, by: T.total - 12, text: "Shahi. Your agents, as a chat on your phone.", say: "[warmly] Shahi. Your agents, as a chat on your phone." },
];

export type Spoken = {
  line: Line;
  mp3: string;
  /** Seconds of the take that belong to the line; the rest is the throwaway tail. */
  cut: number;
  /** Sentence-level timings, in seconds from the start of the clip, for captions. */
  sentences: { text: string; start: number; end: number }[];
};

type Alignment = { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };
/** `cut` is where the line ends in the take, in seconds: inside the pause before the throwaway word. */
type Take = { seed: number; cut: number; alignment: Alignment };

const DIR = join(import.meta.dirname, "vo");

/** Speaks every line (from the cache when it can) and returns where each sits in its clip. */
export async function speak(): Promise<Spoken[]> {
  mkdirSync(DIR, { recursive: true });
  const out: Spoken[] = [];
  const used = new Set<string>();
  for (const line of LINES) {
    const words = line.say ?? line.text;
    const request = { text: words + VOICE.tail, model_id: VOICE.model, voice_settings: VOICE.settings };
    const hash = createHash("sha256").update(JSON.stringify([VOICE.id, request])).digest("hex").slice(0, 10);
    const mp3 = join(DIR, `${line.id}-${hash}.mp3`), json = join(DIR, `${line.id}-${hash}.json`);
    used.add(`${line.id}-${hash}.mp3`).add(`${line.id}-${hash}.json`);

    if (!existsSync(mp3) || !existsSync(json)) {
      const key = process.env.ELEVENLABS_API_KEY;
      if (!key) throw new Error(`No cached speech for "${line.id}" and ELEVENLABS_API_KEY is not set.`);
      let kept = false;
      for (let k = 0; k < VOICE.attempts && !kept; k++) {
        const seed = VOICE.seed + k;
        const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE.id}/with-timestamps?output_format=${VOICE.format}`, {
          method: "POST",
          headers: { "xi-api-key": key, "content-type": "application/json" },
          body: JSON.stringify({ ...request, seed }),
        });
        if (!res.ok) throw new Error(`ElevenLabs answered ${res.status} for "${line.id}": ${await res.text()}`);
        const data = (await res.json()) as { audio_base64: string; alignment: Alignment };
        writeFileSync(mp3, Buffer.from(data.audio_base64, "base64"));
        const x = decode(mp3, 48000);
        const cut = cutBeforeTail(x, 48000);
        const tail = cut === null ? 0 : tailDb(x.subarray(0, Math.round(cut * 48000)), 48000);
        kept = cut !== null && tail < CLEAN_TAIL_DB;
        console.log(`  spoke "${line.id}" with seed ${seed} (${request.text.length} characters): ${cut === null ? "no pause before the tail" : `line ends at ${tail.toFixed(1)} dB`}, ${kept ? "kept" : "trying the next seed"}`);
        if (kept) writeFileSync(json, JSON.stringify({ seed, cut: cut!, alignment: data.alignment } satisfies Take));
      }
      if (!kept) {
        rmSync(mp3);
        throw new Error(`No take of "${line.id}" in ${VOICE.attempts} seeds ended cleanly before its tail; reword the line or raise VOICE.attempts.`);
      }
    }

    const take = JSON.parse(readFileSync(json, "utf8")) as Take;
    out.push({ line, mp3, cut: take.cut, sentences: sentences(take.alignment, words.length, line.text) });
  }
  // The cache is committed: takes no line uses any more would only grow the repository.
  for (const f of readdirSync(DIR)) if (!used.has(f)) rmSync(join(DIR, f));
  return out;
}

/**
 * Each caption sentence's span in the clip, as the alignment reports it; the
 * generator corrects these against the waveform, because v3's alignment gives
 * each pause to the word after it. The alignment covers `say`, direction tags
 * included; with the tags removed it differs from the caption only inside
 * words and in which mark ends a sentence, so sentence boundaries line up. A tag's own sound (a
 * sigh) is not in the alignment, which is why placement uses the waveform.
 */
function sentences(full: Alignment, spoken: number, caption: string) {
  // The alignment has one entry per character of the request: the line's own come first, then the tail's.
  const raw: Alignment = {
    characters: full.characters.slice(0, spoken),
    character_start_times_seconds: full.character_start_times_seconds.slice(0, spoken),
    character_end_times_seconds: full.character_end_times_seconds.slice(0, spoken),
  };
  let depth = 0;
  const keep = raw.characters.map((c) => {
    if (c === "[") depth++;
    const k = depth === 0;
    if (c === "]") depth--;
    return k;
  });
  const a: Alignment = {
    characters: raw.characters.filter((_, i) => keep[i]),
    character_start_times_seconds: raw.character_start_times_seconds.filter((_, i) => keep[i]),
    character_end_times_seconds: raw.character_end_times_seconds.filter((_, i) => keep[i]),
  };
  const chars = a.characters;

  const captionSentences = caption.match(/[^.?!]+[.?!]+/g)?.map((s) => s.trim()) ?? [caption];
  const bounds: { start: number; end: number }[] = [];
  let cur: { start: number; end: number } | null = null;
  for (let i = 0; i < chars.length; i++) {
    if (!chars[i].trim()) continue;
    cur ??= { start: a.character_start_times_seconds[i], end: 0 };
    cur.end = a.character_end_times_seconds[i];
    if (/[.?!]/.test(chars[i]) && !/[.?!]/.test(chars[i + 1] ?? "")) { bounds.push(cur); cur = null; }
  }
  if (cur) bounds.push(cur);
  if (bounds.length !== captionSentences.length) throw new Error(`Caption "${caption}" has ${captionSentences.length} sentences; the speech has ${bounds.length}.`);
  return captionSentences.map((text, i) => ({ text, ...bounds[i] }));
}

/**
 * Where to end the line in a take that carries the throwaway tail: 150 ms into
 * the longest silence, which is the [long pause] (measured at 1.7-2 s, against
 * pauses under 0.8 s between the line's own sentences), so the last word keeps
 * its natural decay. Null when there is no such pause to cut in.
 */
function cutBeforeTail(x: Float32Array, sr: number): number | null {
  const runs = speechRuns(x, sr);
  let best = -1, gap = 0;
  for (let g = 1; g < runs.length; g++) if (runs[g][0] - runs[g - 1][1] > gap) { gap = runs[g][0] - runs[g - 1][1]; best = g; }
  return best > 0 && gap >= 1 ? runs[best - 1][1] + 0.15 : null;
}
