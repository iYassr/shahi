# Dictation

Tap the microphone beside Send and speak. Words appear in a panel above the
reply box as you talk, tentative ones dimmed until Apple's model settles them.
Tap the microphone again, or **Add**, and what you said joins the draft; tap
**Send** when ready. **Cancel** throws the dictation away.

## Engine: Apple's SpeechTranscriber, and nothing else

Dictation uses Apple's on-device SpeechTranscriber (iOS 26, the model behind
Notes and Voice Memos), fed live from the microphone
(`mobile/modules/dictation`). On an iPhone that cannot run it, there is no
microphone button; the keyboard's own dictation remains. There is deliberately
no second engine:

- **DictationTranscriber**, Apple's older model, measured 9.02% / 16.25% word
  errors on LibriSpeech clean / noisy against SpeechTranscriber's 2.12% / 4.56%
  (Lyonesse, July 2026).
- **Whisper small**, which an earlier build downloaded (191 MB), measured
  3.74% / 7.95% on the same test, gave no live text and could invent words in
  silence.
- NVIDIA's Parakeet TDT v2 is slightly more accurate (2.01% / 3.40%) but is a
  ~465 MB download of our own; SpeechTranscriber's model belongs to iOS, is
  shared with other apps and costs the app nothing to store or update.

No custom vocabulary: SpeechTranscriber does not accept any ("SpeechTranscriber
does not support this", Apple, developer forum thread 801877), and biasing is
only offered by the weaker model. Technical words such as `callback` or a file
name can come out split ("call back"); correct them in the draft. A corrector
fed with the project's file names was considered and deliberately left out
until real dictations show it is needed.

`fastResults` is on. Measured with `modules/dictation/tests/run.sh` on an
Apple silicon Mac (macOS 27, 2026-09-29): the first live words came 4.1 s into
an 11 s sentence without it and 1.0 s with it; the final text, and the 0.2 s
from stop to final text, were the same.

## Behaviour

- **iOS 26 and an iPhone that runs SpeechTranscriber** (reported as iPhone 12
  and later). English: the person's own variant when Apple has it, else US.
- **First use:** iOS downloads Apple's English model once, with progress
  shown. Its arrival does not open the microphone; the next tap does. If iOS
  later removes the model, the next tap downloads it again.
- **Permissions:** the microphone, asked on the first Start. The speech
  recognition purpose string is declared too, because iOS ends an app that
  reaches a protected API without one; on the Mac the engine ran with speech
  authorization still undetermined, so iOS may never show that prompt.
- **Nothing is lost:** a call, an unplugged headset, the app going to the
  background, the five-minute limit, or leaving the conversation all finish
  the dictation and add what was said to that conversation's draft. If the
  last words fail, the words already settled on screen are kept.
- **Nothing is sent:** dictated text continues the draft (after a space, or
  after the line break an attached path ends in). Only Send sends.
- **Private:** audio goes from the microphone into Apple's analyzer and is
  never written to disk or sent anywhere. See `docs/privacy-policy.md`.

## Tests

- `bash mobile/modules/dictation/tests/run.sh` (Mac, macOS 26+, Xcode): the
  real SpeechTranscriber on synthesized English, streamed at real-time pace in
  microphone-sized buffers. It checks live text arrives and the final text
  contains the sentence, and prints timings.
- `mobile/src/components/dictation.test.tsx`: live and final text, Add, Cancel,
  interruption, leaving mid-sentence, failure of the last words, first-use
  download, a removed model, a refused microphone, and unsupported iPhones.
- `mobile/src/screens/pane.test.tsx`: dictated words reach the reply box and
  nothing is sent.

## On a real iPhone (not yet done)

The simulator has no SpeechTranscriber model. On a device, in a scratch
conversation:

1. Fresh install: the microphone button appears; the first tap downloads the
   model without recording; the next tap asks for the microphone. Note whether
   a speech recognition prompt appears.
2. Dictate a sentence with a file name, a command and a pause. Time the first
   live words and stop-to-draft. Compare with the Mac's 1.0 s / 0.2 s.
3. Interrupt: lock the phone, take a call, unplug a headset, background the
   app, leave the conversation. Each keeps the words said so far, and the
   microphone indicator disappears.
4. AirPods and the built-in microphone; a noisy room.
5. Largest Dynamic Type and VoiceOver: the panel's Cancel and Add stay
   reachable; "Listening" and "Added" are announced.
