import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test as base } from "@playwright/test";

export type ServerHealthOptions = { healthUrls: string[] };

/** HTTP errors still prove the server is alive; the test must judge its response. */
async function connectionFailures(urls: string[]): Promise<string[]> {
  const results = await Promise.all(urls.map(async url => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      await response.body?.cancel();
      return null;
    } catch (error) {
      return `${url}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }));
  return results.filter((result): result is string => result !== null);
}

export const test = base.extend<ServerHealthOptions & { serverHealth: void }>({
  healthUrls: [[], { option: true }],
  serverHealth: [async ({ healthUrls }, use, info) => {
    // Playwright clears outputDir at the start of a run, but preserves it when
    // it replaces a worker after a failure. Both engines share this marker.
    const marker = join(info.project.outputDir, ".server-gone");
    let previous: string | undefined;
    try { previous = readFileSync(marker, "utf8"); } catch { /* first probe */ }
    if (previous) { info.skip(true, previous); return; }

    async function probe() {
      const failures = await connectionFailures(healthUrls);
      if (!failures.length) return null;
      const message = `Local test infrastructure stopped answering:\n${failures.join("\n")}\n` +
        "Later tests are untested, not app regressions. Inspect the Worker logs before rerunning.";
      mkdirSync(info.project.outputDir, { recursive: true });
      writeFileSync(marker, message);
      info.annotations.push({ type: "infrastructure", description: message });
      await info.attach("server-health", { body: message, contentType: "text/plain" });
      return message;
    }

    const before = await probe();
    if (before) throw new Error(before);
    await use();
    // Preserve the original assertion failure; attach evidence instead of
    // replacing it or retrying a failed test into a passing result.
    if (info.errors.length) await probe();
  }, { auto: true }],
});

export { expect } from "@playwright/test";
