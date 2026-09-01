/**
 * Generates `.env` — the passcode hash, cookie signing key, and VAPID keypair.
 *
 * Kept out of the server itself deliberately: a default passcode or a derived
 * signing key would quietly defeat the point of having either. Existing values
 * are preserved unless `--force` is passed, so re-running this cannot silently
 * invalidate every phone's session or push subscription.
 *
 *   bun run server/scripts/init-secrets.ts [--passcode 1234] [--force]
 *
 * Writes `.env` at the repo root, or wherever `SHAHI_ENV_FILE` points — the
 * herdr plugin keeps it in its config directory (see lib/secrets.ts).
 */
import { ensureSecrets, envFilePath, readEnvFile, writeEnvFile } from "../lib/secrets";

const ENV_PATH = envFilePath();

const args = process.argv.slice(2);
const force = args.includes("--force");
const passcodeArg = args[args.indexOf("--passcode") + 1];
const passcode = args.includes("--passcode") && passcodeArg ? passcodeArg : null;

const { env, created, kept } = await ensureSecrets(readEnvFile(ENV_PATH), { passcode, force });
writeEnvFile(ENV_PATH, env);

console.log(`wrote ${ENV_PATH} (mode 0600)`);
if (created.length) console.log(`  created: ${created.join(", ")}`);
if (kept.length) console.log(`  kept:    ${kept.join(", ")}`);

if (!env.get("PASSCODE_HASH_B64")) {
  console.log(
    "\n  No passcode set. Anyone who can reach the port has full control of every\n" +
      "  agent on this machine. Set one before publishing over Tailscale:\n" +
      "    bun run server/scripts/init-secrets.ts --passcode <digits>",
  );
}
