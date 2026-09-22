/**
 * install-herdr.sh is the only way CI puts a herdr binary on a runner, and
 * every later step trusts that binary. These run the real script with a fake
 * `gh` standing in for GitHub's release record and a file:// URL for the
 * asset, so what is proven is the script's own checking.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "install-herdr.sh");
// The asset is a script that leaves a mark if anything runs it.
const HERDR = (dir: string, build: string) => `#!/bin/sh\ntouch "${dir}/ran"\necho "herdr ${build}"\n`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "install-herdr-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Publishes `bytes` as the release's herdr-linux-x86_64, recorded with `digest`. */
function publish(tag: string, bytes: string, digest: string | null) {
  writeFileSync(join(dir, "asset"), bytes);
  const record = {
    tag_name: tag,
    assets: [
      { name: "herdr-macos-aarch64", browser_download_url: "file:///nonexistent", digest: `sha256:${"0".repeat(64)}` },
      { name: "herdr-linux-x86_64", browser_download_url: `file://${join(dir, "asset")}`, digest },
    ],
  };
  writeFileSync(join(dir, "release.json"), JSON.stringify(record));
  mkdirSync(join(dir, "bin"), { recursive: true });
  // The fake answers only the one request the script should make.
  writeFileSync(
    join(dir, "bin", "gh"),
    `#!/bin/sh\n[ "$*" = "api repos/herdrdev/herdr/releases/tags/${tag}" ] || { echo "unexpected: gh $*" >&2; exit 2; }\ncat "${join(dir, "release.json")}"\n`,
  );
  chmodSync(join(dir, "bin", "gh"), 0o755);
}

function install(...args: string[]) {
  const home = join(dir, "home");
  const run = Bun.spawnSync(["bash", SCRIPT, ...args], {
    env: { ...process.env, HOME: home, PATH: `${join(dir, "bin")}:${process.env.PATH}` },
  });
  return { code: run.exitCode, stderr: run.stderr.toString(), binary: join(home, ".local", "bin", "herdr") };
}

test("a herdr binary whose bytes differ from its release digest is never installed", () => {
  publish("v0.9.1", HERDR(dir, "tampered"), `sha256:${sha256(HERDR(dir, "released"))}`);
  const result = install("v0.9.1");
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("does not match its release digest");
  expect(existsSync(result.binary)).toBe(false);
  expect(existsSync(join(dir, "ran"))).toBe(false);
});

test("a pinned tag whose asset was replaced upstream is refused", () => {
  // GitHub's digest describes the replacement faithfully, so only the pin catches it.
  const replacement = HERDR(dir, "replacement");
  publish("v0.9.0", replacement, `sha256:${sha256(replacement)}`);
  const result = install("v0.9.0", sha256(HERDR(dir, "pinned")));
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("is not the pinned one");
  expect(existsSync(result.binary)).toBe(false);
});

test("a release that records no digest is refused rather than trusted", () => {
  publish("preview-2026-09-21", HERDR(dir, "preview"), null);
  const result = install("preview-2026-09-21");
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("records no SHA-256 digest");
  expect(existsSync(result.binary)).toBe(false);
});

test("a release without a linux asset is refused", () => {
  publish("v0.9.1", HERDR(dir, "released"), `sha256:${sha256(HERDR(dir, "released"))}`);
  const record = JSON.parse(readFileSync(join(dir, "release.json"), "utf8"));
  record.assets = record.assets.filter((a: { name: string }) => a.name !== "herdr-linux-x86_64");
  writeFileSync(join(dir, "release.json"), JSON.stringify(record));
  const result = install("v0.9.1");
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("has no herdr-linux-x86_64 asset");
});

test("a verified binary is installed executable, pinned or not, and never run", () => {
  const released = HERDR(dir, "released");
  publish("v0.9.1", released, `sha256:${sha256(released)}`);
  // herdr.dev's manifest could spell the pin in capitals; it is the same digest.
  for (const pin of [[], [sha256(released).toUpperCase()]]) {
    const result = install("v0.9.1", ...pin);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(readFileSync(result.binary, "utf8")).toBe(released);
    expect(statSync(result.binary).mode & 0o111).toBe(0o111);
    rmSync(join(dir, "home"), { recursive: true });
  }
  expect(existsSync(join(dir, "ran"))).toBe(false);
});
