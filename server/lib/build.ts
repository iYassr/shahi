import { readFileSync } from "node:fs";
// Capture once: reading on each request would let an old process report the
// newly installed files' identifier without actually loading their code.
export const buildId: string | undefined = (() => {
  try { return readFileSync(new URL("../../.shahi-build", import.meta.url), "utf8").trim() || undefined; }
  catch { return undefined; }
})();
