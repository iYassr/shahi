/** Operator CLI: the token is read from a private file, never put in argv or output. */
import { readFileSync, statSync } from "node:fs";
const command = process.argv[2] ?? "status";
const path = process.env.SHAHI_OPERATIONS_SECRETS;
if (!path) throw new Error("Set SHAHI_OPERATIONS_SECRETS to the private operations-secrets.json path.");
if ((statSync(path).mode & 0o077) !== 0) throw new Error("The secrets file must be private (chmod 600).");
const config = JSON.parse(readFileSync(path, "utf8"));
const routes: Record<string, [string, string]> = { status: ["GET", "/ops/status"], stats: ["GET", "/stats"], check: ["POST", "/ops/check"], "test-alert": ["POST", "/ops/test-alert"] };
const route = routes[command];
if (!route) throw new Error("Choose status, stats, check, or test-alert (sends a setup email).");
const response = await fetch(`https://relay.getshahi.dev${route[1]}`, { method: route[0], headers: { authorization: `Bearer ${config.STATS_TOKEN}` }, signal: AbortSignal.timeout(60_000) });
if (!response.ok) throw new Error(`Operation failed (${response.status})`);
console.log(JSON.stringify(await response.json(), null, 2));
