import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig(({ mode }) => ({
  base: mode === "hosted" ? "/pwa/" : "/",
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@shahi\/shared$/, replacement: fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)) },
      { find: /^@shahi\/shared\/(.+)$/, replacement: fileURLToPath(new URL("../shared/src/", import.meta.url)) + "$1.ts" },
    ],
  },
  build: { outDir: mode === "hosted" ? "dist-hosted" : "dist", emptyOutDir: true },
  server: {
    // `bun run dev` in web/ talks to the server running on 7171.
    proxy: {
      "/api": "http://127.0.0.1:7171",
      "/ws": { target: "ws://127.0.0.1:7171", ws: true },
    },
  },
}));
