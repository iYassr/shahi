/**
 * Prints a code for a phone to scan.
 *
 *   bun run server/scripts/pair.ts
 *
 * The running server mints the code (it lives in that process's memory, see
 * pairing.ts), so this asks it over loopback. It authenticates the way the
 * server would have it: by signing a session with the SESSION_SECRET from
 * .env. Anyone who can read .env on this box already owns the server, so
 * this adds no one to the trusted set — it only spares them typing a
 * passcode into a phone.
 *
 * A code is a relay code: the phone reaches the box through the relay, from
 * anywhere. A box with `RELAY_URL=` empty has no address a phone could be
 * given, so it mints nothing and is reached over SSH with the passcode.
 */
import QRCode from "qrcode";
import { SHAHI_API_VERSION, type PairingCode, type ServerInfo } from "@shahi/shared";
import { Auth } from "../lib/auth";
import { loadConfig } from "../lib/config";
import { PAIRING_TTL_MS, pairingUrl } from "../lib/pairing";
import { envFilePath, readEnvFile } from "../lib/secrets";

// Bun loads .env from the working directory; this may be run from elsewhere,
// and the herdr plugin keeps the file outside the checkout (SHAHI_ENV_FILE).
const ENV_PATH = envFilePath();

const config = loadConfig({ ...Object.fromEntries(readEnvFile(ENV_PATH)), ...process.env });
const local = `http://${config.host}:${config.port}`;

if (!config.relayUrl) {
  console.error(
    "This box has no relay, so there is no address to put on a code.\n" +
      "Set RELAY_URL in .env to pair a phone, or reach this box over SSH and sign in with the passcode.",
  );
  process.exit(1);
}
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

const url = pairingUrl({
  v: 1,
  server: here.serverId,
  relay: config.relayUrl,
  secret: code.secret,
});

console.log(await QRCode.toString(url, { type: "terminal", small: true }));
console.log(`  Scan this with Shahi — Connect, then "Scan a code".`);
console.log(`  Or paste it:  ${url}\n`);
console.log(`  Relay    ${config.relayUrl} — the phone connects through this, from anywhere`);
console.log(`  Expires  ${new Date(code.expiresAt).toLocaleTimeString()} (${PAIRING_TTL_MS / 60_000} minutes, one use)\n`);

