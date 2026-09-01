/**
 * Prints a code for a phone to scan.
 *
 *   bun run server/scripts/pair.ts [--endpoint https://box.tailnet.ts.net]
 *
 * The running server mints the code (it lives in that process's memory, see
 * pairing.ts), so this asks it over loopback. It authenticates the way the
 * server would have it: by signing a session with the SESSION_SECRET from
 * .env. Anyone who can read .env on this box already owns the server, so
 * this adds no one to the trusted set — it only spares them typing a
 * passcode into a phone.
 *
 * `--endpoint` is the address the *phone* will use, which this box cannot
 * know for certain. Without it the script does what install.sh does: the
 * Tailscale name behind `tailscale serve` if there is one, the bind address
 * if it is not loopback, and otherwise it stops and asks. Whatever it picks is
 * probed before printing, so a wrong guess is said here and not on the phone.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import QRCode from "qrcode";
import { SHAHI_API_VERSION, type PairingCode, type ServerInfo } from "@shahi/shared";
import { Auth } from "../lib/auth";
import { loadConfig } from "../lib/config";
import { PAIRING_TTL_MS, pairingUrl } from "../lib/pairing";

const ENV_PATH = join(import.meta.dir, "..", "..", ".env");

/** Bun loads .env from the working directory; this may be run from elsewhere. */
function readEnv(path: string): Record<string, string> {
  const values: Record<string, string> = {};
  if (!existsSync(path)) return values;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) values[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return values;
}

const args = process.argv.slice(2);
const endpointArg = args.includes("--endpoint") ? args[args.indexOf("--endpoint") + 1] : undefined;

const config = loadConfig({ ...readEnv(ENV_PATH), ...process.env });
const local = `http://${config.host}:${config.port}`;
const auth = new Auth({
  passcodeHash: config.passcodeHash,
  sessionSecret: config.sessionSecret,
  sessionTtlMs: 60_000, // long enough for one request
});
const headers = { cookie: auth.cookie(auth.issue()).split(";")[0]!, "x-shahi-api": String(SHAHI_API_VERSION) };

async function serverInfo(base: string): Promise<ServerInfo | null> {
  try {
    const res = await fetch(`${base}/api/meta`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    const info = (await res.json()) as Partial<ServerInfo>;
    return typeof info.serverId === "string" ? (info as ServerInfo) : null;
  } catch {
    return null;
  }
}

const here = await serverInfo(local);
if (!here) {
  console.error(`Shahi is not answering at ${local}. Is it running? (systemctl --user status shahi)`);
  process.exit(1);
}

const mintRes = await fetch(`${local}/api/pair`, { method: "POST", headers });
if (!mintRes.ok) {
  console.error(`The server refused to mint a code (HTTP ${mintRes.status}). Is SESSION_SECRET in .env the one it runs with?`);
  process.exit(1);
}
const code = (await mintRes.json()) as PairingCode;

const endpoint = (endpointArg ?? (await defaultEndpoint())).replace(/\/$/, "");
if (!endpoint) {
  console.error(
    "Cannot tell what address the phone should use. Pass it:\n" +
      "  bun run server/scripts/pair.ts --endpoint https://your-box.your-tailnet.ts.net",
  );
  process.exit(1);
}

// The same check the phone will make, made here first: a guessed endpoint that
// answers with a different serverId (or nothing) is reported as this box's
// problem, not as a mysterious refusal on the phone.
const there = await serverInfo(endpoint);
const reachable = there?.serverId === here.serverId;

const url = pairingUrl({ v: 1, server: here.serverId, endpoint, secret: code.secret });

console.log(await QRCode.toString(url, { type: "terminal", small: true }));
console.log(`  Scan this with Shahi — Connect, then "Scan a code".`);
console.log(`  Or paste it:  ${url}\n`);
console.log(`  Server   ${endpoint}`);
console.log(`  Expires  ${new Date(code.expiresAt).toLocaleTimeString()} (${PAIRING_TTL_MS / 60_000} minutes, one use)\n`);
if (!reachable) {
  console.warn(
    there
      ? `  WARNING: ${endpoint} answers, but as a different Shahi server. The phone will refuse this code.`
      : `  WARNING: ${endpoint} did not answer from here. If the phone cannot reach it either,\n` +
          `  run again with --endpoint <the address the phone uses>.`,
  );
}

/** What install.sh tells people to open, derived the same way it derives it. */
async function defaultEndpoint(): Promise<string> {
  try {
    const proc = Bun.spawn(["tailscale", "status", "--json"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) === 0) {
      const name = (JSON.parse(out) as { Self?: { DNSName?: string } }).Self?.DNSName?.replace(/\.$/, "");
      // `tailscale serve` fronts the loopback bind on 443; the probe above
      // confirms whether that is actually set up.
      if (name) return `https://${name}`;
    }
  } catch {
    // No tailscale on this box; fall through.
  }
  const loopback = config.host === "127.0.0.1" || config.host === "localhost" || config.host === "::1";
  return loopback ? "" : local;
}
