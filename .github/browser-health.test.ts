/** Exercise Playwright's real worker replacement and output-directory cleanup. */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a dead browser fixture leaves one failed test, skips untested cases, and clears on the next run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shahi-browser-health-"));
  const root = join(import.meta.dir, "..");
  const playwright = require.resolve("@playwright/test");
  const fixture = join(root, "e2e/hosted/fixtures.ts");
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/stop") {
        setTimeout(() => server.stop(true), 10);
        return new Response("stopping");
      }
      // An HTTP failure is still reachable: don't mislabel an app bug as infra.
      return new Response("intentional HTTP error", { status: 503 });
    },
  });
  const url = server.url.href;
  const output = join(dir, "results");
  writeFileSync(join(dir, "playwright.config.ts"), `
    import { defineConfig } from ${JSON.stringify(playwright)};
    export default defineConfig({ testDir: ${JSON.stringify(dir)}, testMatch: /health.spec.ts/,
      workers: 1, retries: 0, reporter: 'json', outputDir: ${JSON.stringify(output)},
      use: { healthUrls: [${JSON.stringify(url)}] } });
  `);
  const header = `import { test, expect } from ${JSON.stringify(fixture)};\n`;
  writeFileSync(join(dir, "health.spec.ts"), header + `
    test('HTTP errors still run assertions', () => {});
    test('worker dies during the test', async () => {
      await fetch(${JSON.stringify(url + "stop")});
      await new Promise(resolve => setTimeout(resolve, 50));
      expect('original failure').toBe('kept');
    });
    test('later tests are absent', () => { throw new Error('must not run'); });
  `);
  async function run() {
    const child = Bun.spawn([process.execPath, join(playwright, "../cli.js"), "test", "--config", join(dir, "playwright.config.ts")], {
      cwd: root, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (!stdout.trim().startsWith("{")) throw new Error(`Playwright did not report results: ${stderr}\n${stdout}`);
    return { code, report: JSON.parse(stdout) };
  }
  try {
    const failed = await run();
    expect(failed.code).toBe(1);
    expect(failed.report.stats).toMatchObject({ expected: 1, unexpected: 1, skipped: 1, flaky: 0 });
    const cases = failed.report.suites[0].specs;
    expect(cases[1].tests[0].results[0].errors[0].message).toContain("original failure");
    expect(cases[1].tests[0].annotations).toContainEqual(expect.objectContaining({ type: "infrastructure" }));
    expect(readFileSync(join(output, ".server-gone"), "utf8")).toContain("Local test infrastructure stopped answering");

    // A new run must not inherit the previous worker's failure marker.
    writeFileSync(join(dir, "health.spec.ts"), header + "test.use({ healthUrls: [] }); test('fresh run', () => {});\n");
    const fresh = await run();
    expect(fresh.code).toBe(0);
    expect(fresh.report.stats).toMatchObject({ expected: 1, unexpected: 0, skipped: 0 });
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
