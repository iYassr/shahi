import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth } from "./lib/auth";

/**
 * A sidecar that cannot start used to throw, and Bun printed five lines of
 * the minified release around the cause: about 5 KB per attempt, lines of a
 * thousand characters, restarted every few seconds by the manager — 127 MB of
 * log a day for one sentence (pre-release bug hunt). Run here as the release
 * runs it: bundled and minified, with no source maps.
 */
const scratch = mkdtempSync(join(tmpdir(), "shahi-startup-"));
const bundle = join(scratch, "service.js");
let passcodeHash = "";

beforeAll(async () => {
  const built = await Bun.build({ entrypoints: [join(import.meta.dir, "index.ts")], target: "bun", minify: true });
  if (!built.success) throw new Error(built.logs.join("\n"));
  await Bun.write(bundle, built.outputs[0]!);
  passcodeHash = Buffer.from(await Auth.hashPasscode("2468")).toString("base64");
}, 60_000);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function start(env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, bundle], {
    cwd: scratch,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: scratch,
      SHAHI_ENV_FILE: "",
      PASSCODE_HASH_B64: passcodeHash,
      SESSION_SECRET: "k".repeat(43),
      HERDR_SOCKET_PATH: join(scratch, "no-herdr.sock"),
      SHAHI_DATA: join(scratch, "data", "shahi.sqlite"),
      RELAY_URL: "",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 20_000);
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  clearTimeout(timer);
  return { code, lines: (out + err).split("\n").filter((line) => line.trim()) };
}

test("a sidecar that cannot listen says so in one short line, not 5 KB of minified source", async () => {
  // Another program's server on the port, with Bun's defaults.
  const other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("theirs") });
  try {
    const { code, lines } = await start({ PORT: String(other.port) });
    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z Shahi could not start: .*in use/);
    expect(lines[0]!.length).toBeLessThan(300);
  } finally {
    other.stop(true);
  }
}, 30_000);

test("a .env value that stops startup is one line naming it", async () => {
  const { code, lines } = await start({ PORT: "7171", SHAHI_ALLOWED_HOSTS: "http://not a host" });
  expect(code).toBe(1);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("Shahi could not start:");
  expect(lines[0]).toContain("SHAHI_ALLOWED_HOSTS");
  expect(lines[0]!.length).toBeLessThan(300);
}, 30_000);
