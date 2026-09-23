import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePairingUrl } from "@shahi/shared/pairing";
import { ensureSecrets, writeEnvFile } from "../lib/secrets";

// Scratch directories made below, removed when the file finishes. Some hold
// generated secrets, and every run left them in $TMPDIR until the September
// 2026 review.
const scratches: string[] = [];
const scratch = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratches.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
});

/**
 * The plugin keeps its default relay out of the .env — in the service's
 * environment only, so the relay can move — and pair.ts used to read the
 * relay from the .env alone. Run the documented way (`--code-only` with
 * SHAHI_ENV_FILE), it said "This box has no relay" of a box `shahi.status`
 * showed connected, and told the person to write the default into the file
 * the design keeps it out of (pre-release review).
 */

const SERVER_ID = `${"s".repeat(42)}A`;
const SECRET = `${"k".repeat(42)}A`;
let relay: { url: string; connected: boolean } | undefined;
const sidecar = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/api/meta") return Response.json({ serverId: SERVER_ID, api: { min: 5, max: 5 }, ...(relay ? { relay } : {}) });
    if (pathname === "/api/pair" && req.method === "POST") return Response.json({ secret: SECRET, expiresAt: Date.now() + 600_000 });
    return new Response("not here", { status: 404 });
  },
});
afterAll(() => void sidecar.stop(true));

/** pair.ts --code-only against the sidecar above, with a plugin's .env: no RELAY_URL key at all. */
async function codeOnly() {
  const dir = scratch("shahi-pair-");
  const envFile = join(dir, "shahi.env");
  const { env } = await ensureSecrets(new Map([["PORT", String(sidecar.port)]]), { passcode: "2468" });
  writeEnvFile(envFile, env);
  const proc = Bun.spawn([process.execPath, "run", join(import.meta.dir, "pair.ts"), "--code-only"], {
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: dir, SHAHI_ENV_FILE: envFile },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, out: out.trim(), err };
}

test("a plugin box on the default relay gets a code for the relay it dials", async () => {
  relay = { url: "https://relay.example.test", connected: true };
  const { code, out, err } = await codeOnly();
  expect(err).not.toContain("no relay");
  expect(code).toBe(0);
  expect(parsePairingUrl(out)).toEqual({ v: 1, server: SERVER_ID, relay: "https://relay.example.test", secret: SECRET });
});

test("a box that dials no relay says so, without sending anyone to write the default into the .env", async () => {
  relay = undefined;
  const { code, out, err } = await codeOnly();
  expect(code).toBe(1);
  expect(out).toBe("");
  expect(err).toContain("dials no relay");
  expect(err).not.toContain("Set RELAY_URL in .env");
});
