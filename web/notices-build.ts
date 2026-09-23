/**
 * Publishes the web client's third-party notices beside it, as
 * `third-party-notices.txt`, linked from Settings and from both ways in.
 *
 * Every page load copies React, React Router, xterm.js, pdf.js and the rest to
 * the browser, and their licenses ask for their notices to go with them;
 * nothing did before the September 2026 review (F27). The list is Vite's own
 * module graph for this build — the same packages the bundle was made from —
 * so it is rebuilt with every release and cannot fall behind a dependency
 * update. The agent marks that `@shahi/shared/brand` draws add their own
 * notices.
 *
 * Plain text rather than a page of the app: it has to open from the sign-in
 * screens, before there is a session, and the service worker precaches it
 * with the rest of the release, so it opens offline too.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import type { Plugin } from "vite";
import { ARTWORK_NOTICES } from "../shared/src/artwork-notices.ts";
import { collectNotices, formatNotices, packageDirOf, type ExtraNotice, type NestedPolicy } from "../scripts/third-party-notices.ts";
import { NOTICES_FILE } from "./src/notices.ts";

/**
 * Vite writes two small helpers of its own into the bundle, as the virtual
 * modules `vite/preload-helper.js` and `vite/modulepreload-polyfill.js`. Its
 * LICENSE.md is Vite's MIT notice followed by 110 KB of notices for the
 * dependencies inside Vite's own Node build, none of which reach a browser,
 * so only the first part is Vite's notice for those helpers.
 */
function viteNotice(): ExtraNotice {
  const dir = dirname(createRequire(import.meta.url).resolve("vite/package.json"));
  const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string };
  const license = readFileSync(join(dir, "LICENSE.md"), "utf8");
  const core = license.split(/^# Licenses of bundled dependencies/m)[0]!.trim();
  return { name: `vite ${version}: the module-preload helpers the build adds`, license: "MIT", text: core };
}

/** The notices file for a build made from these module ids. */
export function webNotices(ids: readonly string[]): string {
  // Ids can carry a query (`pdf.worker.min.mjs?url`) or the \0 of a virtual
  // module; the file is what matters.
  const files = ids.map((id) => id.replace(/^\0/, "").replace(/\?.*$/, ""));
  const dirs = new Set(files.flatMap((file) => packageDirOf(file) ?? []));
  // A licence file inside a package (pdfjs-dist/wasm/LICENSE_OPENJPEG) covers
  // only what sits beside it, so it is included when the build used a file
  // from there, and not otherwise.
  const nested: NestedPolicy = (_pkg, file, dir) => {
    const under = join(dir, dirname(file)) + sep;
    return files.some((used) => used.startsWith(under)) ? "see its licence" : null;
  };
  return formatNotices(
    "Third-party software in the Shahi web app",
    [
      ...ARTWORK_NOTICES.map((notice) => ({ name: `${notice.name}: ${notice.covers}`, license: notice.license, text: notice.text })),
      ...files.some((file) => file.startsWith("vite/")) ? [viteNotice()] : [],
    ],
    collectNotices(dirs, nested),
  );
}

export function thirdPartyNotices(): Plugin {
  return {
    name: "shahi:third-party-notices",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: NOTICES_FILE, source: webNotices([...this.getModuleIds()]) });
    },
  };
}
