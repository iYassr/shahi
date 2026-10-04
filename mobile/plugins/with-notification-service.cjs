const { withDangerousMod, withEntitlementsPlist, withXcodeProject } = require("expo/config-plugins");
const { copyFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

/**
 * The Notification Service Extension that opens sealed notifications
 * (plugins/notification-service, docs/notifications.md).
 *
 * `mobile/ios` is generated and not tracked, so the target is written here
 * and `expo prebuild --clean` makes it again: the Swift sources are copied
 * from this folder, and the extension's Info.plist and entitlements are
 * written beside them. The pbxproj edits follow the established pattern for
 * extension targets in config plugins (the `xcode` package's `addTarget`,
 * as OneSignal's and Expo's own target plugins use it).
 *
 * Both targets get one shared keychain access group, `<team>.<bundle>.push`:
 * the app stores each computer's push key there and the extension reads it.
 * The app's own group stays first in its list, because the first group is
 * where every item written without a group lands — listed second, the
 * shared group holds the push keys and nothing else, and the extension, which
 * has only that group, cannot read the app's credentials.
 */
const TARGET = "NotificationService";
const SOURCES = ["NotificationService.swift", "PushEnvelope.swift"];

const plist = (body) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
</dict>
</plist>
`;

module.exports = function withNotificationService(config) {
  const bundleId = config.ios?.bundleIdentifier;
  const team = config.ios?.appleTeamId;
  if (!bundleId || !team) throw new Error("The notification service extension needs ios.bundleIdentifier and ios.appleTeamId in app.json.");
  const shared = `$(AppIdentifierPrefix)${bundleId}.push`;
  // EAS discovers signing targets before prebuild creates the Xcode project.
  // Declare the same target here so a managed cloud archive also receives its
  // distribution profile and shared-keychain entitlement.
  const eas = config.extra?.eas ?? {};
  const build = eas.build ?? {};
  const experimental = build.experimental ?? {};
  const ios = experimental.ios ?? {};
  config.extra = { ...config.extra, eas: { ...eas, build: { ...build, experimental: { ...experimental, ios: {
    ...ios, appExtensions: [
      ...(ios.appExtensions ?? []).filter(extension => extension.targetName !== TARGET),
      { targetName: TARGET, bundleIdentifier: `${bundleId}.${TARGET}`, entitlements: { "keychain-access-groups": [shared] } },
    ],
  } } } } };

  config = withEntitlementsPlist(config, mod => {
    mod.modResults["keychain-access-groups"] = [`$(AppIdentifierPrefix)${bundleId}`, shared];
    return mod;
  });

  config = withDangerousMod(config, ["ios", mod => {
    const dir = join(mod.modRequest.platformProjectRoot, TARGET);
    mkdirSync(dir, { recursive: true });
    for (const file of SOURCES) copyFileSync(join(__dirname, "notification-service", file), join(dir, file));
    // CFBundleVersion follows the build setting, so the build number given
    // to xcodebuild (CURRENT_PROJECT_VERSION) reaches the app and the
    // extension alike: App Store Connect expects the two to match.
    writeFileSync(join(dir, `${TARGET}-Info.plist`), plist(`  <key>CFBundleDevelopmentRegion</key>
  <string>$(DEVELOPMENT_LANGUAGE)</string>
  <key>CFBundleDisplayName</key>
  <string>Shahi notifications</string>
  <key>CFBundleExecutable</key>
  <string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key>
  <string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$(PRODUCT_NAME)</string>
  <key>CFBundlePackageType</key>
  <string>$(PRODUCT_BUNDLE_PACKAGE_TYPE)</string>
  <key>CFBundleShortVersionString</key>
  <string>${config.version ?? "1.0.0"}</string>
  <key>CFBundleVersion</key>
  <string>$(CURRENT_PROJECT_VERSION)</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key>
    <string>com.apple.usernotifications.service</string>
    <key>NSExtensionPrincipalClass</key>
    <string>$(PRODUCT_MODULE_NAME).NotificationService</string>
  </dict>`));
    writeFileSync(join(dir, `${TARGET}.entitlements`), plist(`  <key>keychain-access-groups</key>
  <array>
    <string>${shared}</string>
  </array>`));
    return mod;
  }]);

  return withXcodeProject(config, mod => {
    const project = mod.modResults;
    if (project.pbxTargetByName(TARGET)) return mod;
    const objects = project.hash.project.objects;
    // `addTarget` makes the app depend on the extension, and skips that
    // silently when the project has none of these sections yet, as a fresh
    // prebuild does not.
    objects.PBXTargetDependency ??= {};
    objects.PBXContainerItemProxy ??= {};

    const appSettings = Object.values(project.pbxXCBuildConfigurationSection())
      .find(c => c?.buildSettings?.PRODUCT_BUNDLE_IDENTIFIER?.replace(/"/g, "") === bundleId)?.buildSettings ?? {};

    // The Info.plist and entitlements are named by build settings below;
    // listed in the group, `addPbxGroup` gives each a stray build file.
    const group = project.addPbxGroup(SOURCES, TARGET, TARGET);
    project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup);

    const target = project.addTarget(TARGET, "app_extension", TARGET, `${bundleId}.${TARGET}`);
    project.addBuildPhase(SOURCES, "PBXSourcesBuildPhase", "Sources", target.uuid);
    project.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", target.uuid);
    project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", target.uuid);

    for (const configuration of Object.values(project.pbxXCBuildConfigurationSection())) {
      const settings = configuration?.buildSettings;
      if (settings?.PRODUCT_NAME !== `"${TARGET}"`) continue;
      Object.assign(settings, {
        CODE_SIGN_ENTITLEMENTS: `${TARGET}/${TARGET}.entitlements`,
        CODE_SIGN_STYLE: "Automatic",
        CURRENT_PROJECT_VERSION: appSettings.CURRENT_PROJECT_VERSION ?? 1,
        DEVELOPMENT_TEAM: team,
        GENERATE_INFOPLIST_FILE: "NO",
        IPHONEOS_DEPLOYMENT_TARGET: appSettings.IPHONEOS_DEPLOYMENT_TARGET ?? "16.4",
        PRODUCT_BUNDLE_IDENTIFIER: `"${bundleId}.${TARGET}"`,
        SWIFT_VERSION: "5.0",
        TARGETED_DEVICE_FAMILY: appSettings.TARGETED_DEVICE_FAMILY ?? '"1,2"',
      });
    }
    project.addTargetAttribute("DevelopmentTeam", team, target);
    return mod;
  });
};
