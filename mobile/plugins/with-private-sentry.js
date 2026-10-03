const { withAppDelegate, withInfoPlist, withXcodeProject } = require("expo/config-plugins");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

module.exports = function withPrivateSentry(config, { dsn }) {
  config = withInfoPlist(config, mod => { mod.modResults.ShahiSentryDSN = dsn; return mod; });
  config = withXcodeProject(config, mod => {
    const phase = mod.modResults.pbxItemByComment("Upload Debug Symbols to Sentry", "PBXShellScriptBuildPhase");
    if (!phase) throw new Error("Register with-private-sentry before @sentry/react-native/expo so its Xcode mod runs last.");
    const script = JSON.parse(phase.shellScript);
    // Xcode launched from Finder does not inherit a shell's Node PATH. Match
    // Expo's bundle phase before Sentry tries to resolve its own script.
    if (!script.includes(".xcode.env.local")) phase.shellScript = JSON.stringify([
      'if [ -f "$PODS_ROOT/../.xcode.env" ]; then . "$PODS_ROOT/../.xcode.env"; fi',
      'if [ -f "$PODS_ROOT/../.xcode.env.local" ]; then . "$PODS_ROOT/../.xcode.env.local"; fi',
      script,
    ].join("\n"));
    return mod;
  });
  return withAppDelegate(config, mod => {
    if (mod.modResults.language !== "swift") throw new Error("Shahi's Sentry privacy filter requires the Swift AppDelegate.");
    let source = mod.modResults.contents;
    const marker = "// Native crashes bypass JavaScript's beforeSend.";
    source = source.split(marker)[0];
    source = source.replace(/^import Sentry\n/m, "").replace(/^ *ShahiSentry.install\(\)\n/m, "");
    const launch = /(func application\([^)]*\) -> Bool \{)\s*\n(\s*)/s;
    if (!launch.test(source)) throw new Error("Could not install Shahi's native Sentry privacy filter.");
    source = source.replace(launch, "$1\n$2ShahiSentry.install()\n$2");
    // The redaction rules follow the filter, after the marker, so a second
    // prebuild replaces both; its own Foundation import is the AppDelegate's.
    const redaction = readFileSync(join(__dirname, "sentry-redaction.swift"), "utf8").replace(/^import Foundation\n/m, "");
    mod.modResults.contents = "import Sentry\n" + source + readFileSync(join(__dirname, "sentry-native.swift"), "utf8") + "\n" + redaction;
    return mod;
  });
};
