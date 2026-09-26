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
 *
 * Which relay is the running server's answer, not this script's reading of
 * the .env. The plugin keeps its default relay out of the file, in the
 * service's environment only, so reading the file said "This box has no
 * relay" of a box that `shahi.status` showed connected, and sent the person
 * to write the default into the file the design keeps it out of (pre-release
 * review). Over loopback, /api/meta names the relay the box actually dials.
 */
import QRCode from "qrcode";
import { showPairingPopup } from "../lib/pairing-display";
import { SHAHI_API_VERSION, type PairingCode, type ServerInfo } from "@shahi/shared";
import { Auth } from "../lib/auth";
import { loadConfig } from "../lib/config";
import { herdrCli } from "../lib/herdr-session";
import { pairingUrl } from "../lib/pairing";
import { envFilePath, readEnvFile } from "../lib/secrets";
import { copyToClipboard } from "../lib/clipboard";

// Bun loads .env from the working directory; this may be run from elsewhere,
// and the herdr plugin keeps the file outside the checkout (SHAHI_ENV_FILE).
const ENV_PATH = envFilePath();

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
  console.error(`Shahi is not answering at ${local}. Is it running?  ${herdrCli(process.env.HERDR_SOCKET_PATH)} plugin action invoke shahi.status`);
  process.exit(1);
}
const relay = here.relay?.url;
if (!relay) {
  console.error(
    "This box dials no relay (its RELAY_URL is empty), so there is no address to put on a code.\n" +
      "Reach it over SSH and sign in with the passcode, or give it a relay and restart it.",
  );
  process.exit(1);
}

const mintRes = await fetch(`${local}/api/pair`, { method: "POST", headers });
if (!mintRes.ok) {
  // A refusal of the session key is usually not the key. Any Shahi answers
  // /api/meta, so another user's sidecar or a development checkout on this
  // port got this far, and the message that blamed SESSION_SECRET sent the
  // person to edit a file that was right (pre-release bug hunt).
  const refused = mintRes.status === 401 || mintRes.status === 403;
  console.error(
    refused
      ? `The server at ${local} refused this install's session key (HTTP ${mintRes.status}), so it is probably not this install's Shahi: ` +
          "another program — another user's Shahi, or a development checkout — may hold the port. " +
          `${herdrCli(process.env.HERDR_SOCKET_PATH)} plugin action invoke shahi.status says; if the port is taken, put PORT=<a free port> in ${ENV_PATH} and restart. ` +
          "If it is this install's, the SESSION_SECRET in that file is not the one it runs with."
      : `The server at ${local} refused to mint a code (HTTP ${mintRes.status}).`,
  );
  process.exit(1);
}
const code = (await mintRes.json()) as PairingCode;

const url = pairingUrl({
  v: 1,
  server: here.serverId,
  relay,
  secret: code.secret,
});

// For a normal terminal or a pipe: no QR, clipboard changes, or popup wait.
if (process.argv.includes("--code-only")) {
  console.log(url);
  process.exit(0);
}

const copied = !process.argv.includes("--no-copy") && copyToClipboard(url);
if (process.argv.includes("--popup") && process.stdout.isTTY) {
  await showPairingPopup(url, code.expiresAt, copied);
} else {
  console.log("Scan with Shahi");
  console.log(await QRCode.toString(url, { type: "terminal", small: true }));
  console.log(`Expires ${new Date(code.expiresAt).toLocaleTimeString()} · one use`);
  console.log(copied ? "Pairing code copied to clipboard." : "Use --code-only to copy the pairing code.");
}
