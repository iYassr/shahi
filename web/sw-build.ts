/**
 * Stamps the service worker with the release it ships in.
 *
 * `public/sw.js` is copied into the build as it is, and its cache name used to
 * be a hand-bumped constant. Nothing tied it to the files it cached, so:
 *
 *  - unhashed files — `welcome.js`, the manifest, the icons — stayed stale in
 *    installed apps until someone remembered to bump it, which was missed twice
 *    (5c1dea8, 4a7a60c);
 *  - every release's bundles and lazily loaded chunks piled up in one cache
 *    that was never cleared (the pre-release review measured 0.5–2.3 MB a
 *    release);
 *  - only the chunks a page had already opened were ever cached, so a page
 *    left open across a deploy could not open the terminal or a PDF at all.
 *
 * After the build writes its files, this hashes all of them, together with the
 * worker's own source, into `RELEASE`, and lists them in `FILES`. Any change to
 * anything the app ships is a byte change to `sw.js`, which is what makes a
 * browser install the new worker; the worker names its cache after the release
 * and precaches every file in it.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "vite";

const RELEASE_LINE = /^const RELEASE = "[^"\n]*";$/m;
const FILES_LINE = /^const FILES = \[[^\n]*\];$/m;

export interface ReleaseFile {
  /** Relative to the build's root, with forward slashes. */
  path: string;
  bytes: Uint8Array;
}

export function stampServiceWorker(source: string, files: readonly ReleaseFile[]): string {
  // A worker without its release identity would silently go back to one cache
  // for every release. Fail the build instead.
  if (!RELEASE_LINE.test(source) || !FILES_LINE.test(source)) {
    throw new Error("sw.js must keep its `const RELEASE = \"…\";` and `const FILES = […];` lines for the build to stamp");
  }
  const sorted = [...files].filter((file) => file.path !== "sw.js").sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = createHash("sha256").update(source);
  for (const file of sorted) hash.update(`\0${file.path}\0${file.bytes.byteLength}\0`).update(file.bytes);
  const release = hash.digest("hex").slice(0, 16);
  // The HTML is the shell, which the worker fetches and stores by itself.
  const cached = sorted.map((file) => file.path).filter((path) => path !== "index.html");
  return source
    .replace(RELEASE_LINE, () => `const RELEASE = "${release}";`)
    .replace(FILES_LINE, () => `const FILES = ${JSON.stringify(cached)};`);
}

async function releaseFiles(root: string, prefix = ""): Promise<ReleaseFile[]> {
  const files: ReleaseFile[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await releaseFiles(root, path));
    else if (entry.isFile()) files.push({ path, bytes: await readFile(join(root, path)) });
  }
  return files;
}

/** Runs after every file, public ones included, has been written. */
export function serviceWorkerRelease(): Plugin {
  return {
    name: "shahi:service-worker-release",
    apply: "build",
    async writeBundle(options) {
      const root = options.dir;
      if (!root) throw new Error("The service worker can only be stamped into a build directory");
      const worker = join(root, "sw.js");
      await writeFile(worker, stampServiceWorker(await readFile(worker, "utf8"), await releaseFiles(root)));
    },
  };
}
