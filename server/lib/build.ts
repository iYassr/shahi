import { readFileSync } from "node:fs";
// Capture once: reading on each request would let an old process report the
// newly installed files' identifier without actually loading their code.
export const buildId: string | undefined = (() => {
  if (process.env.SHAHI_BUILD_ID) return process.env.SHAHI_BUILD_ID;
  try { return readFileSync(new URL("../../.shahi-build", import.meta.url), "utf8").trim() || undefined; }
  catch { return undefined; }
})();
