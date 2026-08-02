import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // The shared contract is TypeScript source in a sibling workspace, so it
      // is aliased rather than resolved through node_modules — Vite compiles it
      // as part of this app instead of expecting a built package.
      "@shahi/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    // `bun run dev` in web/ talks to the server running on 7171.
    proxy: {
      "/api": "http://127.0.0.1:7171",
      "/ws": { target: "ws://127.0.0.1:7171", ws: true },
    },
  },
});
