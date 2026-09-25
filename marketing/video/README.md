# Launch video

A 30-second silent product video, rendered from code with [Remotion](https://remotion.dev):
1920×1080 (`Wide`) and 1080×1080 (`Square`). The app screens are rebuilt as
components with realistic content rather than taken from `docs/screenshots/`,
whose placeholder text would not survive a marketing cut.

```sh
bun install
bun run studio     # scrub and edit in the browser
bun run render     # out/shahi-16x9.mp4 and out/shahi-1x1.mp4
```

Timing lives in `src/theme.ts` (`S`), copy in `src/Video.tsx`, the phone in
`src/Phone.tsx`. Colors and fonts are the brand's (docs/brand/README.md).

## Launch cut

A second cut for LinkedIn and Reddit, 32 seconds with sound, `LaunchWide` and
`LaunchSquare`, built on the positioning rather than the walkthrough: the hook,
why a terminal on a phone does not work, setup in two commands and a scan, the
conversation with a permission prompt answered by a tap, herdr's spaces and
panes mirrored on the phone, and the end card. Sources are in `src/launch/`.

```sh
bun run render:launch   # the soundtrack, then out/shahi-launch-16x9.mp4 and -1x1.mp4
bun run sound           # just the soundtrack and captions
bun run typecheck
bun scripts/publish-media.ts --remote   # web encodes, poster and captions to the site's R2; then deploy (docs/browser-hosting.md, Media)
```

`src/launch/timeline.ts` is the one place timing lives. The picture and the
soundtrack both read it, so every sound lands on the frame of its action. At
120 BPM a beat is 15 frames: every cut after the hook sits on a bar line, and
the build stops if a moved cut leaves the grid.

**Soundtrack.** `audio/generate.ts` renders music, sound effects and the
voice-over into one WAV (`public/audio/launch.wav`, ignored by git, rebuilt by
`bun run sound`; `studio` and `render:launch` run it first). Everything but the
voice is synthesized in `audio/dsp.ts`, with seeded noise, so it has no licence
questions and the same bytes every run. The mix is -15 LUFS integrated with a
-1.5 dBFS ceiling. The music drops about 10 dB under the voice and a little
under each effect. `bun audio/generate.ts --stems <dir>` writes each bus and
prints its level per scene, plus how far the voice stands above the music.

**Voice-over.** The script is `LINES` in `audio/voiceover.ts`: ElevenLabs
`eleven_v3` with George, with bracketed direction such as `[sighs]` or
`[excited]` at the start of a line. Direction in the middle of a line added
second-long pauses. v3 ends its audio where its text ends, often inside the
last sound, so every line is spoken with a pause and a throwaway word after it
(`VOICE.tail`). The take is cut in that pause, and it is kept only if the line
then ends in silence; otherwise the next seed is tried. Speech is cached in
`audio/vo/`, which is committed, so rendering never needs a key. A changed line
is spoken again only when `ELEVENLABS_API_KEY` is set; keep the key in your
environment, never in the repository. Lines are placed by their audible start,
which includes a sigh before the first word, and the build stops if one runs
past its cut. Captions are timed from the waveform, not from ElevenLabs'
alignment: the alignment gives each pause to the word after it. The build writes
`out/shahi-launch.en.vtt` for the website's captions and `.srt` for LinkedIn's
caption upload.

**Before posting.** The takes in `audio/vo/` were made on ElevenLabs' free plan,
which does not grant a commercial licence. Upgrade the plan, delete `audio/vo/`,
and run `ELEVENLABS_API_KEY=… bun run render:launch` to speak them again under
it. New takes differ a little; the build re-checks every ending and every fit.

It names Termius, Blink and WhatsApp in text only. No logos or product UI
appear, and the phone screens are drawn from the app's own reader layout
(YOU blocks, agent labels, tool cards), not chat bubbles.

Remotion is free for individuals and companies of up to three people; larger
companies need a company license.
