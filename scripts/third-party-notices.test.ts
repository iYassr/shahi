/**
 * The app's third-party notices are generated, and these tests are what keep
 * the generated file honest without bundling the app: a dependency update
 * that changes what the app could ship fails here until
 * `bun run notices:app` is run again and its output committed.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import recorded from "../mobile/src/screens/third-party-notices.json";
import { MOBILE, nestedPolicy } from "./app-notices";
import { EXTERNAL_PODS } from "../mobile/src/screens/native-notices";
import { closureDigest, collectNotices, dependencyClosure, externalPods, formatNotices, packageDirOf } from "./third-party-notices";

const REGENERATE = "Run `bun run notices:app` and commit mobile/src/screens/third-party-notices.json.";
const closure = dependencyClosure(MOBILE);

test("the app's notices are regenerated whenever its dependencies change", () => {
  // Every package the app can ship is in this closure, at the version
  // installed, so an added, removed or updated one changes the digest.
  if (closureDigest(closure) !== recorded.closure) {
    throw new Error(`mobile's production dependencies changed since the app's notices were generated. ${REGENERATE}`);
  }
});

test("every notice the app shows is its package's own licence file, at the installed version", () => {
  const byVersion = new Map([...closure].map(([dir, id]) => [id, dir]));
  // Entries named by a path inside a package (expo-updates/vendor/bspatch)
  // come from their package's directory, which is listed too.
  const dirs = recorded.packages.flatMap((pkg) => byVersion.get(`${pkg.name}@${pkg.version}`) ?? []);
  const regenerated = collectNotices(dirs, nestedPolicy);
  expect(regenerated.packages).toEqual(recorded.packages);
  expect(regenerated.texts).toEqual(recorded.texts);
});

// Folly, Hermes, ZXingObjC and ReachabilitySwift reached the App Store binary
// from outside node_modules with no notice (F27): CocoaPods fetched them
// because a podspec asked. A podspec that starts asking for another pod
// fails here until native-notices.ts carries its notice or EXTERNAL_PODS says
// why the app does not link it.
test("a native library from outside node_modules cannot reach the app without its notice being decided", () => {
  const wanted = externalPods(closure.keys());
  const undecided = [...wanted].filter(([pod]) => !(pod in EXTERNAL_PODS)).map(([pod, from]) => `${pod} (asked for by ${from.join(", ")})`);
  expect(undecided).toEqual([]);
  // And nothing is decided that no podspec asks for any more.
  expect(Object.keys(EXTERNAL_PODS).filter((pod) => !wanted.has(pod))).toEqual([]);
});

const fixture = mkdtempSync(join(tmpdir(), "shahi-notices-test-"));
afterAll(() => rmSync(fixture, { recursive: true, force: true }));
function install(name: string, manifest: object, files: Record<string, string> = {}) {
  const dir = join(fixture, "node_modules", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", ...manifest }));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}

test("a package with no licence file is named with where its licence is, never given an invented text", () => {
  const dir = install("bare", { license: "MIT", repository: { url: "git+https://github.com/example/bare.git" } });
  const { packages, texts } = collectNotices([dir]);
  expect(texts).toEqual([]);
  expect(packages).toEqual([{
    name: "bare", version: "1.0.0", license: "MIT", text: null,
    note: "The published package includes no licence file. Its package.json declares MIT, and its source and licence are at https://github.com/example/bare.",
  }]);
});

test("packages that share a licence text store it once, with CRLF and trailing blanks not making it different", () => {
  const text = "MIT License\n\nCopyright (c) Meta Platforms, Inc. and affiliates.\n";
  const a = install("shared-a", { license: "MIT" }, { LICENSE: text });
  const b = install("shared-b", { license: "MIT" }, { "LICENSE.md": `${text.replace(/\n/g, "\r\n")}\n\n` });
  const c = install("apache", { license: "Apache-2.0" }, { LICENSE: "Apache License", NOTICE: "Apache Foo\nCopyright Foo" });
  const { packages, texts } = collectNotices([a, b, c]);
  expect(texts).toEqual(["Apache License\n\nApache Foo\nCopyright Foo", text.trimEnd()]);
  expect(packages.map((pkg) => [pkg.name, pkg.text])).toEqual([["apache", 0], ["shared-a", 1], ["shared-b", 1]]);
});

test("vendored code inside a package is listed only when the policy says the build ships it", () => {
  const dir = install("host", { license: "MIT" }, {
    LICENSE: "host licence",
    "vendor/zlib/LICENSE": "zlib licence",
    "android/LICENSE": "android licence",
  });
  const policy = (pkg: string, file: string) => (file === "vendor/zlib/LICENSE" ? "Zlib" : null);
  expect(collectNotices([dir], policy).packages).toEqual([
    { name: "host", version: "1.0.0", license: "MIT", text: 0 },
    { name: "host/vendor/zlib", version: "1.0.0", license: "Zlib", text: 1 },
  ]);
  // The app's own policy refuses to guess about a licence nobody has read.
  expect(() => collectNotices([dir], nestedPolicy)).toThrow(/Decide whether the iOS app contains/);
});

test("a bundled file is attributed to the innermost package on its path, and Shahi's own files to none", () => {
  expect(packageDirOf("/r/node_modules/a/node_modules/@s/b/lib/x.js")).toBe("/r/node_modules/a/node_modules/@s/b");
  expect(packageDirOf("/r/node_modules/react/index.js")).toBe("/r/node_modules/react");
  expect(packageDirOf("/r/mobile/src/app/_layout.tsx")).toBeUndefined();
  expect(packageDirOf("/r/shared/src/e2e.ts")).toBeUndefined();
});

test("the web notices file lists each package under the text it shares", () => {
  const text = formatNotices("Title", [{ name: "Art", license: "MIT", text: "art licence\n" }], {
    packages: [
      { name: "a", version: "1.0.0", license: "MIT", text: 0 },
      { name: "b", version: "2.0.0", license: "MIT", text: 0 },
      { name: "c", version: "3.0.0", license: "MIT", text: null, note: "No file." },
    ],
    texts: ["shared licence"],
  });
  expect(text).toContain("Art (MIT)\n\nart licence");
  expect(text).toContain("a 1.0.0 (MIT)\nb 2.0.0 (MIT)\n\nshared licence");
  expect(text).toContain("c 3.0.0 (MIT)\n\nNo file.");
});
