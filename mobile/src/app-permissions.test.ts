/**
 * @jest-environment node
 */

/**
 * The purpose strings the built app declares, as prebuild will write them.
 *
 * `mobile/ios` is generated, so app.json plus every config plugin is the only
 * source of truth for Info.plist — and plugins disagree with each other.
 * expo-camera deleted the microphone string, then expo-image-picker (whose mod
 * runs after it) wrote Expo's placeholder "Allow $(PRODUCT_NAME) to access
 * your microphone" back, and a bare "expo-secure-store" added a placeholder
 * Face ID string. The app uses neither, and a shipped binary declared both
 * (pre-release review). This runs the same introspection as
 * `expo config --type introspect`, so a plugin upgrade or a new plugin that
 * re-adds one fails here rather than in App Review.
 */
jest.setTimeout(60_000);

test("the built app declares no microphone or Face ID purpose, and keeps the scanner's camera and the photo picker's library strings", async () => {
  // mobile/, where app.json lives: this file is mobile/src/app-permissions.test.ts.
  const projectRoot = expect.getState().testPath!.replace(/[\\/]src[\\/][^\\/]+$/, "");
  // Plugins warn about Android features this iOS-first app does not install.
  jest.spyOn(console, "warn").mockImplementation(() => {});
  const { getPrebuildConfigAsync } = require("@expo/prebuild-config");
  const { compileModsAsync } = require("@expo/config-plugins/build/plugins/mod-compiler.js");
  const config = await getPrebuildConfigAsync(projectRoot, { platforms: ["ios", "android"] });
  await compileModsAsync(config.exp, { projectRoot, introspect: true, platforms: ["ios", "android"], assertMissingModProviders: false });
  const plist = config.exp.ios.infoPlist as Record<string, unknown>;

  expect(plist).not.toHaveProperty("NSMicrophoneUsageDescription");
  expect(plist).not.toHaveProperty("NSFaceIDUsageDescription");
  expect(plist.NSCameraUsageDescription).toBe("Shahi uses the camera to scan the pairing code your server prints.");
  expect(plist.NSPhotoLibraryUsageDescription).toMatch(/^Shahi attaches a photo/);
  // No placeholder wording of any kind: every purpose string is Shahi's own.
  for (const [key, value] of Object.entries(plist)) if (key.endsWith("UsageDescription")) expect(value).not.toMatch(/\$\(PRODUCT_NAME\)/);
  expect(config.exp.android.permissions).not.toContain("android.permission.RECORD_AUDIO");
});
