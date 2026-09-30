import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { serviceWorkerRelease } from "./sw-build";
import { thirdPartyNotices } from "./notices-build.ts";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { privateSourcemaps } from "./sentry-build";
import { execFileSync } from "node:child_process";

const release = `shahi-web@${process.env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()}`;
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
