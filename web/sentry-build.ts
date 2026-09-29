import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";

/** Keep debug artifacts for the trusted release job, outside the served app. */
export function privateSourcemaps(destination: string): Plugin {
  return {
    name: "shahi:private-sourcemaps", apply: "build",
    buildStart() { rmSync(destination, { recursive: true, force: true }); },
    writeBundle: { order: "pre", sequential: true, handler(options) {
      if (!options.dir) throw new Error("Debug artifacts require a build directory");
      const visit = (path: string, prefix = "") => {
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          const file = join(path, entry.name), relative = join(prefix, entry.name);
          if (entry.isDirectory()) visit(file, relative);
          else if (entry.isFile() && entry.name.endsWith(".js.map")) {
            const target = join(destination, relative);
            mkdirSync(dirname(target), { recursive: true });
            copyFileSync(file, target);
            copyFileSync(file.slice(0, -4), target.slice(0, -4));
            rmSync(file);
          }
        }
      };
      visit(options.dir);
    } },
  };
}
