# On-device voice input

Status: implemented for a new native iOS build; not included in TestFlight 24.
Physical-device acceptance is still required before publishing this feature.

Open a conversation, tap the microphone, select a language, then tap Record.
If the language needs a download, download it first and tap Record separately.
Stop and transcribe, correct the text, and choose Add to reply. Your previous
draft stays intact. Send is still a separate, explicit action in the conversation.
Recordings have a five-minute limit. You can draft without a connection to your
computer once the selected language model is installed.

## Engine and availability

This first implementation uses Apple's SpeechAnalyzer on iOS 26 or later.
SpeechTranscriber is preferred when the device supports it and it supports the
selected locale; otherwise it uses DictationTranscriber through the same
on-device analyzer. The app lists the languages the device reports, including
Arabic variants only where Apple reports support. It does not infer support
from the app language and does not promise reliable mixed-language dictation.
Older iOS versions can still run Shahi and type replies; opening voice input
explains its requirements. Android and the browser app have no voice button.

The engine choice avoids bundling a second speech runtime and model-management
system. It is not an accuracy or battery benchmark result. WhisperKit has not
been integrated or measured. If the Arabic or technical-word acceptance checks
below fail, compare it with an on-device multilingual WhisperKit model on the
same device before deciding whether to replace or supplement Apple's engine.

Primary references: [Apple's SpeechAnalyzer introduction](https://developer.apple.com/videos/play/wwdc2025/277/),
[SpeechTranscriber](https://developer.apple.com/documentation/speech/speechtranscriber),
[DictationTranscriber](https://developer.apple.com/documentation/speech/dictationtranscriber),
[AssetInventory](https://developer.apple.com/documentation/speech/assetinventory),
and [WhisperKit](https://github.com/argmaxinc/argmax-oss-swift).

## Privacy and failure handling

- Audio stays in a protected temporary file on the phone, excluded from backup.
  Transcription, cancellation, interruptions and backgrounding delete it; any
  files left by a killed process are removed next time the voice module opens.
- Only microphone access is requested. This module does not call the legacy
  cloud-capable recognizer or upload audio. Apple supplies system language
  models, and controls their download, updates and storage.
- The transcript is editable and appended to the existing draft. It is not an
  attachment and is not sent until the conversation's Send button is tapped.
- Every recording has its own lease ID. Late downloads, permission replies,
  native events and transcription results cannot affect another conversation.
- A model evicted by iOS returns the UI to an explicit download step. Permission
  denial offers Settings. Empty/failed speech can be retried. Transcription that
  takes longer than two minutes is cancelled; it never retries a prompt send.

## Physical-device acceptance

Use a scratch agent/session, not an active work conversation. Record the app
build, iPhone model, iOS version, language and whether its model was already
installed. Do not commit private audio or transcripts as test fixtures.

1. Open voice input on a fresh install. No microphone prompt should appear
   until Record. Deny it, check the explanation, enable it in Settings and retry.
2. Download English and an available Arabic locale. Verify download completion
   does not record. With airplane mode on, capture, stop, edit and add a draft.
   Reconnect, then explicitly Send to the scratch conversation exactly once.
3. Speak short and long samples in English, Arabic and Arabic mixed with English
   technical names. Use the same sentences for every engine comparison:
   “Update the README, run bun test, and fix the OAuth callback.”
   “افتح الجلسة الجديدة وراجع الأخطاء قبل إرسال الرد.”
   “راجع ملف CLAUDE.md وشغّل bun test ثم أصلح خطأ OAuth.”
   Also record a file path, punctuation and a multiline instruction. Check
   corrections needed, missing or duplicated phrases, Arabic text direction,
   start delay and stop-to-editable-text time; do not call unmeasured accuracy
   or latency good. Missing a required language is an acceptance failure.
4. Cancel during download, the permission prompt, recording and transcription.
   Navigate away and switch computer/conversation. No old text may appear in
   the new composer, and reopening voice input must work.
5. Lock the phone, background the app, receive a call, and disconnect a headset.
   Recording must stop and its temporary audio must be removed. Confirm the
   microphone indicator disappears. Retry successfully after each interruption.
6. Record silence, a short phrase and the full five-minute limit. Repeat Stop
   and Add to reply taps. Never duplicate text or submit automatically. Check
   speaker/Bluetooth routes and a low-storage or failed model download.
7. Check small-screen layout, largest Dynamic Type, VoiceOver, editing with the
   keyboard visible, Arabic selection and long language names. Add to reply and
   Cancel must remain reachable. Check the old-iOS explanation separately.
8. Use Instruments on repeated recordings to check peak memory, CPU/energy and
   cleanup after cancellation. A simulator and mocked native module cannot
   establish these results. Report measurements with device and sample duration.

Automated tests cover the UI state transitions, cancellation and stale results,
language downloads and model eviction, permission declarations, duration and
transcription timeouts, preserving drafts and requiring an explicit Send.
They do not replace the checks above.
