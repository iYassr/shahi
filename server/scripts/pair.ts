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
import QRCode from "qrcode";
import { SHAHI_API_VERSION, type PairingCode, type ServerInfo } from "@shahi/shared";
import { Auth } from "../lib/auth";
import { loadConfig } from "../lib/config";
import { phoneEndpoint, tailscaleStatus } from "../lib/endpoint";
import { PAIRING_TTL_MS, pairingUrl } from "../lib/pairing";
import { envFilePath, readEnvFile } from "../lib/secrets";

// Bun loads .env from the working directory; this may be run from elsewhere,
// and the herdr plugin keeps the file outside the checkout (SHAHI_ENV_FILE).
const ENV_PATH = envFilePath();

const args = process.argv.slice(2);
const endpointArg = args.includes("--endpoint") ? args[args.indexOf("--endpoint") + 1] : undefined;

const config = loadConfig({ ...Object.fromEntries(readEnvFile(ENV_PATH)), ...process.env });
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

const url = pairingUrl({
  v: 1,
  server: here.serverId,
  endpoint,
  // The phone prefers the relay when the box has one: it works from anywhere.
  ...(config.relayUrl ? { relay: config.relayUrl } : {}),
  secret: code.secret,
});

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

/**
 * What install.sh tells people to open, derived the same way it derives it.
 * `tailscale serve` fronts the loopback bind on 443; the probe above confirms
 * whether that is actually set up.
 */
async function defaultEndpoint(): Promise<string> {
  return phoneEndpoint(await tailscaleStatus(), config.host, config.port);
}
