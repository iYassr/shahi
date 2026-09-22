import { mkdirSync } from "node:fs";
import { join } from "node:path";
const root = join(import.meta.dir, "..");
mkdirSync(join(import.meta.dir, "build"), { recursive: true });
for (const [entry, name] of [["server/index.ts", "server"], ["demo/container/controller.ts", "controller"], ["demo/container/model.ts", "model"], ["demo/container/tools.ts", "tools"]]) {
  const result = await Bun.build({ entrypoints: [join(root, entry!)], target: "bun", outdir: join(import.meta.dir, "build"), naming: `${name}.js` });
  if (!result.success) throw new Error(`Could not build ${name}: ${result.logs.join("\n")}`);
}
