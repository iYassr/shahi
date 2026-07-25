import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    // `bun run dev` in web/ talks to the server running on 7171.
    proxy: {
      "/api": "http://127.0.0.1:7171",
      "/ws": { target: "ws://127.0.0.1:7171", ws: true },
    },
  },
});
