import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { serviceWorkerRelease } from "./sw-build";
import { thirdPartyNotices } from "./notices-build.ts";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { privateSourcemaps } from "./sentry-build";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function localRevision(): string {
  // Bun's macOS test runner can hand a piped child an invalid descriptor.
  // Let the child open its output file, as agent discovery does here.
  const scratch = mkdtempSync(join(tmpdir(), "shahi-build-revision-"));
  const output = join(scratch, "revision");
  try {
    execFileSync("sh", ["-c", 'git rev-parse HEAD > "$1"', "sh", output], { cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: ["ignore", "inherit", "inherit"] });
    return readFileSync(output, "utf8").trim();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
const release = `shahi-web@${process.env.GITHUB_SHA ?? localRevision()}`;
const debugArtifacts = (mode: string) => fileURLToPath(new URL(`../dist/sentry/${mode === "hosted" ? "hosted" : "computer"}`, import.meta.url));

export default defineConfig(({ mode }) => ({
  base: mode === "hosted" ? "/pwa/" : "/",
  // The notices file is emitted into the bundle, so the service worker,
  // stamped once everything is written, precaches it with the release.
  plugins: [react(), thirdPartyNotices(), privateSourcemaps(debugArtifacts(mode)), serviceWorkerRelease(), sentryVitePlugin({
    org: "yasser-dx", project: "shahi-web", authToken: process.env.SENTRY_AUTH_TOKEN, telemetry: false,
    errorHandler: error => { throw error; },
    release: { name: release }, sourcemaps: { assets: `${debugArtifacts(mode)}/**/*` },
  })],
  resolve: {
    alias: [
      { find: /^@shahi\/shared$/, replacement: fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)) },
      { find: /^@shahi\/shared\/(.+)$/, replacement: fileURLToPath(new URL("../shared/src/", import.meta.url)) + "$1.ts" },
    ],
  },
  build: { outDir: mode === "hosted" ? "dist-hosted" : "dist", emptyOutDir: true, sourcemap: "hidden" },
  server: {
    // `bun run dev` in web/ talks to the server running on 7171.
    proxy: {
      "/api": "http://127.0.0.1:7171",
      "/ws": { target: "ws://127.0.0.1:7171", ws: true },
    },
  },
}));
