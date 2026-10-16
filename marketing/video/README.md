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

## Phone cut

A 60-second cut about the app itself, `PhoneWide`, `PhoneSquare` and
`PhoneTall` (9:16), with sound: a terminal squeezed onto a phone, then Reader,
one-tap answers, every agent, herdr's workspace, setup and SSH, notifications,
dictation, the rest, and the end card. Sources are in `src/phone/`; its timeline
is `src/phone/timeline.ts`, read by the picture, `audio/phone.ts` and
`audio/phone-voiceover.ts`, as the launch cut's is.

```sh
bun run render:phone    # the soundtrack, then out/shahi-phone-16x9.mp4, -1x1.mp4 and -9x16.mp4
bun run sound:phone     # just the soundtrack and out/shahi-phone.en.{vtt,srt}
bun run stills:phone    # one still per scene and format, in out/phone-stills/ (--at 405,410 for others)
```

**Footage.** What the phone shows of the app is the app: the 1.1.2 Release
build on an iPhone 17 Pro Max simulator, paired with the encrypted fixture on
its showcase scenario (`e2e/stub/showcase.ts`, invented projects and agents),
recorded by `capture/capture.ts` into `public/phone/`. Those files are
committed (4 MB), so rendering needs no simulator. To record them again: the
simulator set up as `marketing/app-store/README.md` says, Maestro, Homebrew's
ffmpeg, `HOSTED_PORT=7572 bun e2e/hosted/server.ts` from the repository root,
then `bun run capture:phone`. It prints the frames where each clip's movements
begin, and `timeline.ts` and `scenes.tsx` put taps, holds and skips on those
frames, so new footage means reading them again.

Four things are drawn rather than recorded, each because the simulator cannot
show it: the terminal app in the opening (and no real product's interface), the
camera reading the installer's code, the notification on the lock screen, and
dictation. The app asks for notification permission only on a device, so the
simulator never shows its banner; it has no SpeechTranscriber, so no microphone
button. The banner's words are what `server/lib/push.ts` sends, and dictation
follows `mobile/src/components/dictation.tsx`.

**Voice.** The script is `PHONE_LINES` in `audio/phone-voiceover.ts`, spoken
and cached (`audio/vo-phone/`) exactly as the launch cut's, three seeds a line
at most. Lines are placed by their waveform, and the scenes' cues by where each
word is heard, measured the same way; ElevenLabs' alignment puts every word
after a pause half a second early.

**Before posting.** The takes in `audio/vo-phone/` are a draft for timing,
made on the free plan, which has no commercial licence: upgrade, delete
`audio/vo-phone/`, and run `ELEVENLABS_API_KEY=… bun run render:phone`. New
takes differ a little; the build re-checks every ending and fit. Notifications
and dictation have not yet been proven on a physical iPhone (see "What is not
done" in the repository's CLAUDE.md); check both on a device before this cut
says they work.

Remotion is free for individuals and companies of up to three people; larger
companies need a company license.
