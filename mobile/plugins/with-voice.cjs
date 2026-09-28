const { withInfoPlist } = require("expo/config-plugins");

// Info.plist mods run in reverse plugin order: keep this first in app.json so
// it writes after camera/image-picker, which intentionally disable their audio.
module.exports = config => withInfoPlist(config, config => {
  config.modResults.NSMicrophoneUsageDescription = "Shahi records your voice to transcribe a reply on this iPhone. Audio is deleted after transcription or cancellation.";
  return config;
});
