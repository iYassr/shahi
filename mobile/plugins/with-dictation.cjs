const { withInfoPlist } = require("expo/config-plugins");

/**
 * Dictation's purpose strings (mobile/modules/dictation).
 *
 * Info.plist mods run in reverse plugin order, so this stays first in app.json
 * and writes after expo-camera and expo-image-picker, which remove microphone
 * strings on purpose. The speech string is declared because iOS ends an app
 * that reaches a protected API without one; on a Mac, SpeechTranscriber
 * transcribed with speech authorization still undetermined
 * (modules/dictation/tests/run.sh), so iOS may never show that prompt.
 */
module.exports = config => withInfoPlist(config, config => {
  config.modResults.NSMicrophoneUsageDescription = "Shahi listens while you dictate a reply. Your voice is turned into text on this iPhone and is never recorded or sent anywhere.";
  config.modResults.NSSpeechRecognitionUsageDescription = "Shahi turns what you dictate into text with Apple's speech model, on this iPhone.";
  return config;
});
