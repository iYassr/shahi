import { expect, test } from "bun:test";
import { join } from "node:path";
import { thirdPartyNotices, webNotices } from "../notices-build";
import { NOTICES_FILE } from "./notices";

/*
 * Every page load copies the web client's libraries to a browser, and before
 * the September 2026 review (F27) none of their notices went with them. The
 * file is built from the build's own module graph, so these check the
 * translation from module ids to notices, not a list someone keeps.
 */
const root = join(import.meta.dir, "..", "..", "node_modules");

test("the web build publishes a notice for every package its modules came from", () => {
  const text = webNotices([
    join(root, "react", "index.js"),
    join(root, "react-dom", "client.js"),
    `${join(root, "pdfjs-dist", "build", "pdf.worker.min.mjs")}?url`,
    "\0vite/preload-helper.js",
    join(import.meta.dir, "App.tsx"),
  ]);
  expect(text).toMatch(/^react \d+\.\d+\.\d+ \(MIT\)$/m);
  expect(text).toMatch(/^react-dom \d+\.\d+\.\d+ \(MIT\)$/m);
  expect(text).toMatch(/^pdfjs-dist \d+\.\d+\.\d+ \(Apache-2\.0\)$/m);
  expect(text).toContain("Copyright (c) Meta Platforms, Inc. and affiliates.");
  // Vite's own helpers are in the bundle; its notice is, and the 110 KB of
  // notices for Vite's Node-side dependencies is not.
  expect(text).toContain("Copyright (c) 2019-present, VoidZero Inc. and Vite contributors");
  expect(text).not.toContain("Licenses of bundled dependencies");
  // The agent marks both clients draw.
  expect(text).toContain("Tabler Icons: The pi mark (MIT)");
  expect(text).toContain("Primer Octicons: GitHub Copilot’s mark (MIT)");
  expect(text).toContain("Copyright (c) 2026 GitHub Inc.");
  // pdf.js's wasm decoders have licences of their own, and the app ships
  // none of them: only what the build used is listed.
  expect(text).not.toContain("pdfjs-dist/wasm");
});

test("the build writes the notices file the sign-in screens link to", () => {
  const emitted: { fileName: string; source: string }[] = [];
  const plugin = thirdPartyNotices() as { generateBundle: (this: unknown) => void };
  plugin.generateBundle.call({
    getModuleIds: () => [join(root, "react", "index.js")][Symbol.iterator](),
    emitFile: (file: { fileName: string; source: string }) => { emitted.push(file); return "id"; },
  });
  expect(emitted.map((file) => file.fileName)).toEqual([NOTICES_FILE]);
  expect(emitted[0]!.source).toMatch(/^react \d/m);
});
