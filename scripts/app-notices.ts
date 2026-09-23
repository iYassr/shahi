/**
 * Regenerate the iOS app's third-party notices: `bun run notices:app`.
 *
 * The list is what the App Store binary contains, not what package.json
 * declares. Two things put a package's code into it:
 *
 *  - Metro's bundle. The production iOS bundle is built with a source map,
 *    and every file named in the map's `sources` is in the app.
 *  - Autolinking. A native module is compiled into the binary whether or not
 *    any JavaScript imports it — expo-updates and expo-splash-screen have no
 *    JavaScript in the bundle at all — so Expo's own autolinking is asked
 *    which modules a release build links. Debug-only modules are left out.
 *
 * Packages outside node_modules — Shahi's own code, and the ssh-tunnel module
 * whose OpenSSL and libssh2 notices are kept by hand in licenses-text.ts — are
 * not third-party and are skipped.
 *
 * `scripts/third-party-notices.test.ts` fails once the app's dependencies no
 * longer match what this recorded, which is the cue to run it again. It takes
 * about ten seconds and needs no simulator.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closureDigest, collectNotices, dependencyClosure, nestedLicenseFiles, packageDirOf, type NestedPolicy } from "./third-party-notices";

const root = join(import.meta.dir, "..");
export const MOBILE = join(root, "mobile");
export const OUTPUT = join(MOBILE, "src", "screens", "third-party-notices.json");

/**
 * Licence files inside shipped packages, below their root. Whether the iOS
 * binary contains the code beside one takes reading the podspec or the
 * source, so each is decided here by a person, and an undecided one stops
 * the script rather than being guessed either way.
 */
export const NESTED: Record<string, { ships: string } | { skipped: string }> = {
  // The podspec copies bspatch.c into EXUpdates/BSPatch and compiles it: a
  // BSD licence whose notice a binary has to reproduce.
  "expo-updates/vendor/bspatch/LICENSE": { ships: "BSD-2-Clause" },
  "expo-updates/android/src/main/cpp/third-party/bzip2/LICENSE": { skipped: "Android only" },
  "expo-structured-headers/android/LICENSE": { skipped: "Android only" },
  "expo-router/vendor/react-helmet-async/LICENSE": { skipped: "web only; nothing under it is in the iOS bundle" },
  "@expo/ui/src/community/segmented-control/vendor/LICENSE": { skipped: "TypeScript the app never imports; the iOS bundle has no @expo/ui module" },
};

export const nestedPolicy: NestedPolicy = (pkg, file) => {
  const decision = NESTED[`${pkg}/${file}`];
  if (!decision) throw new Error(`${pkg} ships ${file}. Decide whether the iOS app contains the code it covers, and add it to NESTED in scripts/app-notices.ts.`);
  return "ships" in decision ? decision.ships : null;
};

function run(args: string[]): string {
  const result = spawnSync("npx", args, { cwd: MOBILE, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] });
  if (result.status !== 0) throw new Error(`npx ${args.join(" ")} exited ${result.status}`);
  return result.stdout;
}

/**
 * Every third-party file in the production iOS bundle, as the Xcode build
 * embeds it: `expo export:embed` is the command the app's "Bundle React
 * Native code and images" phase runs. (`expo export`'s source map leaves out
 * JSON modules, which this one lists.)
 */
function bundledFiles(): string[] {
  const out = mkdtempSync(join(tmpdir(), "shahi-notices-"));
  try {
    run(["expo", "export:embed", "--platform", "ios", "--dev", "false",
      "--bundle-output", join(out, "main.jsbundle"), "--sourcemap-output", join(out, "main.map"), "--assets-dest", join(out, "assets")]);
    const { sources } = JSON.parse(readFileSync(join(out, "main.map"), "utf8")) as { sources: string[] };
    // Expo names sources from the server root, which is the monorepo's:
    // `/node_modules/react/index.js`, `/mobile/src/app/_layout.tsx`.
    return sources
      .map((source) => source.startsWith(root) ? source : join(root, source))
      .filter((file) => packageDirOf(file) !== undefined)
      .map((file) => realpathSync(file));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

interface ExpoModules { modules: { packageName: string; debugOnly?: boolean; pods: { podspecDir: string }[] }[] }
interface ReactNativeConfig { dependencies: Record<string, { root: string; platforms: { ios?: unknown } }> }

/** Every package whose native code a release build links. */
function linkedPackages(): string[] {
  const dirs: (string | undefined)[] = [];
  const expo = JSON.parse(run(["expo-modules-autolinking", "resolve", "--platform", "apple", "--json"])) as ExpoModules;
  for (const module of expo.modules) {
    if (!module.debugOnly) dirs.push(...module.pods.map((pod) => packageDirOf(join(pod.podspecDir, "podspec"))));
  }
  const community = JSON.parse(run(["expo-modules-autolinking", "react-native-config", "--platform", "ios", "--json"])) as ReactNativeConfig;
  for (const dependency of Object.values(community.dependencies)) {
    if (dependency.platforms.ios) dirs.push(packageDirOf(join(dependency.root, "package.json")));
  }
  return dirs.filter((dir): dir is string => dir !== undefined).map((dir) => realpathSync(dir));
}

if (import.meta.main) {
  const closure = dependencyClosure(MOBILE);
  const files = bundledFiles();
  const shipped = new Set([...files.map((file) => packageDirOf(file)!), ...linkedPackages()]);
  // Anything shipped must be reachable from the app's production
  // dependencies, or the freshness test could not notice it changing.
  const stray = [...shipped].filter((dir) => !closure.has(dir));
  if (stray.length) throw new Error(`Shipped, but not reachable from mobile/package.json:\n${stray.join("\n")}`);
  // And a directory NESTED calls unshipped must really have nothing bundled.
  for (const dir of shipped) {
    const name = closure.get(dir)!.replace(/@[^@]*$/, "");
    for (const file of nestedLicenseFiles(dir)) {
      const under = join(dir, file.slice(0, file.lastIndexOf("/")));
      if (nestedPolicy(name, file) === null && files.some((bundled) => bundled.startsWith(`${under}/`))) {
        throw new Error(`NESTED says ${name}/${file} is not shipped, but the bundle has code under it.`);
      }
    }
  }
  const notices = collectNotices(shipped, nestedPolicy);
  writeFileSync(OUTPUT, `${JSON.stringify({
    "//": "Generated by `bun run notices:app` from the iOS bundle and the autolinked native modules. Do not edit.",
    closure: closureDigest(closure),
    ...notices,
  }, null, 1)}\n`);
  console.log(`${notices.packages.length} entries, ${notices.texts.length} distinct licence texts → ${OUTPUT}`);
}
