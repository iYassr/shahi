/*
 * The App Store binary embeds native libraries that CocoaPods fetches from
 * outside node_modules — React Native's prebuilt dependencies, Hermes,
 * expo-camera's ZXingObjC and expo-updates' ReachabilitySwift — and before
 * the September 2026 review (F27) the app carried none of their notices.
 * These tests pin each text to its upstream file and each version to the pin
 * in node_modules that decides what a build downloads, so updating React
 * Native, Hermes or expo-camera fails here until native-notices.ts has the
 * new release's files. To refresh one: fetch the file named in `files` from
 * the repository at the new tag, replace the text, update the version, tag
 * and the SHA-256 below.
 */
import { licenseRows } from "./licenses";
import { EXTERNAL_PODS, NATIVE_NOTICES, VENDORED_NOTICES } from "./native-notices";

jest.mock("expo-router", () => ({ Stack: { Screen: () => null } }));

// Node's own modules, which the app's type configuration does not describe.
declare const __dirname: string;
const { createHash } = require("node:crypto") as { createHash(algorithm: "sha256"): { update(text: string): { digest(encoding: "hex"): string } } };
const { existsSync, readdirSync, readFileSync } = require("node:fs") as {
  existsSync(path: string): boolean; readdirSync(path: string): string[]; readFileSync(path: string, encoding: "utf8"): string;
};
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const root = `${__dirname}/../../..`;
const read = (path: string) => readFileSync(`${root}/${path}`, "utf8");
const notice = (name: string) => NATIVE_NOTICES.find((n) => n.name === name)!;

test("the app carries the license files of the native libraries CocoaPods builds into it, word for word", () => {
  const upstream: Record<string, string> = {
    "Folly LICENSE": "2206c00af7013581ae0d7c8c8a0089f02fab621913daac019b32336bd4d1e1db",
    "glog COPYING": "0fc497129c5c69ff6f22da6933c7e4aaef082fde8437fd57680c2780100772a4",
    "double-conversion LICENSE": "4af93c12062c58058378de2397dc1c92bbff9ddfb1d583a01c84127557ce97ca",
    "{fmt} LICENSE": "07580f2a3b35709ce703d523f447b242f6dfec7582a8c0df102c7fa2849375f8",
    // The upstream file has CRLF line endings; the hash is of those bytes.
    "Boost LICENSE_1_0.txt": "beb8e42e9d6b4284e03304d05a81a0755200a965fc8d0a5e0aea1e84cf805d6e",
    "fast_float LICENSE-MIT": "e562f3f974ced7e69dd1db77b820b36bcf8f30377f1aa105723fba449c53c4e6",
    "SocketRocket LICENSE": "41c74b84758ab303b091b0afbf958de909559556c8f1591dc4d687ea184356ab",
    "Hermes LICENSE": "da6d3703ed11cbe42bd212c725957c98da23cbff1998c05fa4b3d976d1a58e93",
    "Hermes external/llvh/LICENSE.txt": "8d85c1057d742e597985c7d4e6320b015a9139385cff4cbae06ffc0ebe89afee",
    "Hermes external/llvh/include/llvh/Support/LICENSE.TXT": "a012d664e4e01df52a65b2eeafdfb8aeb856fec0e6c372265d01b0109c3f5e2a",
    "Hermes include/hermes/Regex/LICENSE.TXT": "c1938c0e9e90639d1e8f5a7f6bebaab83a3642e0ee44295a4c69934686d0bda8",
    "Hermes external/dtoa/dtoa.c, lines 1–18": "d04360743ae3338bb08ab2106b51e24309e3ca4b1c6b1186139531ade351b7e3",
    "Hermes external/llvh/lib/Support/ConvertUTF.cpp, lines 9–29": "47e27f87477adf7e9a6cab4f5dceadb82f40cc2f211dc7fc6496b98a1bbee859",
    "ZXingObjC COPYING": "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
    "ZXingObjC NOTICE": "51771c45e75552741f1d781a1663b5f144daaf2d4e0e052e4afc091b3c6a58cd",
    "Reachability.swift LICENSE": "2b44bc6f4a9b9305c6906c2a6ee0e5606993787440fb4a5a7905629ea0d6c386",
  };
  const carried = Object.fromEntries(NATIVE_NOTICES.flatMap((n) => n.files.map((file) => [
    `${n.name} ${file.path}`,
    sha256(n.name === "Boost" ? file.text.replace(/\n/g, "\r\n") : file.text),
  ])));
  expect(carried).toEqual(upstream);
});

test("the native notices name the versions React Native, Hermes and expo-camera make a build download", () => {
  // React Native's prebuilt ReactNativeDependencies is built from the same
  // versions its podspecs build from source (scripts/releases/ios-prebuild/
  // configuration.js at the release tag agrees for 0.86.3).
  const podspec = (name: string) => read(`node_modules/react-native/third-party-podspecs/${name}.podspec`).match(/spec\.version\s*=\s*['"]([^'"]+)['"]/)?.[1];
  const helpers = read("node_modules/react-native/scripts/cocoapods/helpers.rb");
  const config = (name: string) => helpers.match(new RegExp(`@@${name}_config = \\{[^}]*:version => '([^']+)'`))?.[1];
  expect({
    Folly: config("folly"), SocketRocket: config("socket_rocket"),
    glog: podspec("glog"), "double-conversion": podspec("DoubleConversion"), "{fmt}": podspec("fmt"),
    Boost: podspec("boost"), fast_float: podspec("fast_float"),
    // Hermes V1, the engine unless the Podfile turns it off.
    Hermes: read("node_modules/react-native/sdks/.hermesv1version").trim().replace(/^hermes-v/, ""),
    ZXingObjC: (JSON.parse(read("node_modules/expo-camera/spm.config.json")) as { products: { spmPackages?: { productName: string; version: { exact: string } }[] }[] })
      .products.flatMap((product) => product.spmPackages ?? []).find((pkg) => pkg.productName === "ZXingObjC")?.version.exact,
  }).toEqual(Object.fromEntries(["Folly", "SocketRocket", "glog", "double-conversion", "{fmt}", "Boost", "fast_float", "Hermes", "ZXingObjC"]
    .map((name) => [name, notice(name).version])));
  expect(notice("Hermes").tag).toBe(`hermes-v${notice("Hermes").version}`);
  // A library React Native adds to its dependencies gets a podspec here, and
  // a notice in native-notices.ts before this passes again.
  expect(readdirSync(`${root}/node_modules/react-native/third-party-podspecs`).filter((file) => file.endsWith(".podspec")).sort())
    .toEqual(["DoubleConversion", "RCT-Folly", "ReactNativeDependencies", "boost", "fast_float", "fmt", "glog"].map((name) => `${name}.podspec`));
});

// expo-updates depends on ReachabilitySwift without a version, so CocoaPods
// takes the newest from its trunk and only a Podfile.lock records which. The
// lock is generated with mobile/ios and not committed; after a local native
// build this checks it.
const lock = `${root}/mobile/ios/Podfile.lock`;
(existsSync(lock) ? test : test.skip)("a local native build's Podfile.lock links nothing from outside node_modules that the licenses do not name", () => {
  const text = readFileSync(lock, "utf8");
  const trunk = text.match(/^SPEC REPOS:\n  trunk:\n((?:    - .+\n)+)/m)?.[1]?.match(/- (.+)/g)?.map((line) => line.slice(2)) ?? [];
  for (const pod of trunk) expect(EXTERNAL_PODS[pod]).toBeDefined();
  expect(text).toContain(`  - ReachabilitySwift (${notice("Reachability.swift").version})\n`);
  expect(text).toContain(`:tag: ${notice("Hermes").tag}\n`);
});

test("the licenses screen shows each native library's files whole, each under its path", () => {
  const rows = licenseRows();
  expect(rows).toContainEqual(expect.objectContaining({ kind: "section", testID: "licenses-native" }));
  for (const n of NATIVE_NOTICES) {
    expect(rows).toContainEqual(expect.objectContaining({ kind: "title", testID: `license-${n.name}`, title: `${n.name} ${n.version}` }));
    n.files.forEach((file, index) => {
      expect(rows).toContainEqual(expect.objectContaining({ kind: "text", key: `native-file:${n.name}:${index}`, text: file.path }));
      const shown = rows.flatMap((row) => row.kind === "text" && row.key.startsWith(`native:${n.name}:${index}:`) ? [row] : [])
        .map((row, i) => `${i && row.paragraph ? "\n\n" : i ? "\n" : ""}${row.text}`).join("");
      expect(shown).toBe(file.text.replace(/^\s*\n/, "").trimEnd().replace(/\n(?:[ \t]*\n)+/g, "\n\n"));
    });
  }
});

// expo-router ships nine React Navigation packages in build/react-navigation
// with no licence file for them (F27, found after the npm list was generated).
test("React Navigation's licence travels with the copy of it expo-router carries", () => {
  const [nav] = VENDORED_NOTICES;
  // Upstream packages/*/LICENSE, identical in all nine at @react-navigation/native@7.4.1.
  expect(sha256(nav!.files[0]!.text)).toBe("c3bc4b85acdbcfe7b2ffe3c986dcfc0cc98980c1b98154c87fa5a894acd9ac78");
  const carried = readdirSync(`${root}/node_modules/expo-router/build/react-navigation`).filter((name) => !name.includes(".")).sort();
  // A package added here is code whose licence nobody has checked yet.
  expect(carried).toEqual(["bottom-tabs", "core", "drawer", "elements", "material-top-tabs", "native", "native-stack", "routers", "stack"]);
  const rows = licenseRows();
  expect(rows).toContainEqual(expect.objectContaining({ kind: "section", testID: "licenses-vendored" }));
  expect(rows).toContainEqual(expect.objectContaining({ kind: "title", testID: "license-React Navigation" }));
  const shown = rows.flatMap((row) => row.kind === "text" && row.key.startsWith("vendored:React Navigation:0:") ? [row] : [])
    .map((row, i) => `${i && row.paragraph ? "\n\n" : i ? "\n" : ""}${row.text}`).join("");
  expect(shown).toBe(nav!.files[0]!.text.replace(/^\s*\n/, "").trimEnd().replace(/\n(?:[ \t]*\n)+/g, "\n\n"));
});
