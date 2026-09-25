/**
 * What the test tooling leaves behind, found in the September 2026 review.
 *
 * Every `bun run test` left ten directories in $TMPDIR — freshly generated
 * session secrets and VAPID keys among them — and every browser-suite run
 * left the stub's. And Playwright's report, which a failed run fills with
 * traces and error text, landed where nothing stopped `git add -A` from
 * staging it.
 *
 * Children are given a TMPDIR of their own, which must be empty when they
 * finish, and write their output to a file: a piped child under `bun test`
 * on macOS fails at posix_spawn with EBADF (docs/on-a-mac.md).
 */
import { describe, expect, test } from "bun:test";
import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");

/** Runs `argv` from the repository root with a private TMPDIR; returns what it left there. */
async function leftBehind(
  argv: string[],
  extraEnv: Record<string, string>,
  run: (child: Bun.Subprocess, log: string) => Promise<void>,
): Promise<string[]> {
  const outer = mkdtempSync(join(tmpdir(), "shahi-hygiene-"));
  try {
    const scratch = join(outer, "tmp");
    mkdirSync(scratch);
    const log = join(outer, "log");
    const fd = openSync(log, "w");
    try {
      const env: Record<string, string | undefined> = { ...process.env, ...extraEnv, TMPDIR: scratch };
      // Never let a live run's opt-in reach the children: the live suite is
      // one of them.
      delete env.SHAHI_HERDR_LIVE;
      delete env.SHAHI_HERDR_LIVE_AGENT;
      const child = Bun.spawn(argv, { cwd: ROOT, env, stdio: ["ignore", fd, fd] });
      await run(child, log);
    } finally {
      closeSync(fd);
    }
    return readdirSync(scratch);
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
}

describe("the test tooling cleans up after itself", () => {
  test("unit test files that make scratch directories leave none in the temp directory", async () => {
    const files = [
      "server/lib/secrets.test.ts",
      "server/lib/secrets.pentest.test.ts",
      "server/lib/codex-log.test.ts",
      "server/lib/session-log.test.ts",
      "server/lib/odd-rows.test.ts",
      // Skipped without SHAHI_HERDR_LIVE=1 — and a skipped describe's body
      // still runs, while its afterAll does not.
      "server/lib/herdr-live.test.ts",
      "plugin/service.test.ts",
      "plugin/bunpath.pentest.test.ts",
      // Found by the same census once the other pre-release fixes landed; the
      // setup and pairing ones held generated secrets too.
      "plugin/shahi.test.ts",
      "plugin/bun.test.ts",
      "server/scripts/pair.test.ts",
      "server/lib/transcript-watch.test.ts",
    ];
    const left = await leftBehind([process.execPath, "test", ...files.map((file) => `./${file}`)], {}, async (child, log) => {
      if ((await child.exited) !== 0) throw new Error(`the files failed on their own:\n${readFileSync(log, "utf8").slice(-3000)}`);
    });
    expect(left).toEqual([]);
  }, 60_000);

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    test(`the e2e stub removes its files when stopped with ${signal}`, async () => {
      const left = await leftBehind(
        [process.execPath, "run", "e2e/stub/server.ts"],
        // Port 0: the operating system picks a free one; nothing here talks to it.
        { PORT: "0" },
        async (child, log) => {
          // The stub prints its directory once it has made it and is serving.
          const deadline = Date.now() + 15_000;
          while (!readFileSync(log, "utf8").includes("files in ") && Date.now() < deadline) {
            if (child.exitCode !== null) break;
            await Bun.sleep(50);
          }
          if (!readFileSync(log, "utf8").includes("files in ")) {
            child.kill("SIGKILL");
            throw new Error(`the stub did not start:\n${readFileSync(log, "utf8").slice(-3000)}`);
          }
          child.kill(signal);
          await child.exited;
        },
      );
      expect(left).toEqual([]);
    }, 30_000);
  }

  test("the browser suites stop the stub with a signal it can clean up on", async () => {
    // Playwright's default is SIGKILL, which no handler survives. The hosted
    // fixture server embeds the stub, so its entries count too.
    const configs = await Promise.all([
      import("../../e2e/playwright.config"),
      import("../../e2e/hosted/playwright.config"),
      import("../../e2e/hosted/pwa.config"),
    ]);
    const stubs = configs
      .flatMap(({ default: config }) => [config.webServer ?? []].flat())
      .filter((server) => /\/(stub|hosted)\/server\.ts/.test(server.command ?? ""));
    expect(stubs).toHaveLength(4);
    for (const server of stubs) expect({ command: server.command, signal: server.gracefulShutdown?.signal }).toEqual({ command: server.command, signal: "SIGTERM" });
  });

  test("Playwright's HTML report is ignored by git wherever a suite writes it", async () => {
    const { default: config } = await import("../../e2e/playwright.config");
    const html = [config.reporter ?? []].flat().find((reporter) => Array.isArray(reporter) && reporter[0] === "html");
    const folder = (html as [string, { outputFolder?: string }] | undefined)?.[1]?.outputFolder;
    expect(folder).toBeDefined();
    const reports = [
      relative(ROOT, resolve(ROOT, "e2e", folder!)),
      // The hosted configs keep Playwright's default: the directory of the
      // nearest package.json, the repository root.
      "playwright-report",
    ];
    for (const report of reports) {
      const check = Bun.spawnSync(["git", "check-ignore", "-q", "--no-index", join(report, "index.html")], {
        cwd: ROOT,
        stdio: ["ignore", "ignore", "ignore"],
      });
      expect({ report, ignored: check.exitCode === 0 }).toEqual({ report, ignored: true });
    }
  });
});
