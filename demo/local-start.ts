// Local container verification. Credentials stay in an owner-only file outside Git.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = join(process.env.HOME!, ".config/shahi-review-demo");
const secrets = JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8"));
const env = { ...secrets, DEMO_ORIGIN: "http://host.docker.internal:9899", RELAY_URL: "https://relay.getshahi.dev" };
const file = join(dir, "local.env");
writeFileSync(file, Object.entries(env).map(([k,v]) => `${k}=${v}`).join("\n"), { mode: 0o600 });
const run = Bun.spawn(["docker", "run", "-d", "--platform", "linux/amd64", "--name", "shahi-review-demo-local", "-p", "127.0.0.1:9988:8080", "--env-file", file, "shahi-review-demo:local"], { stdout: "ignore", stderr: "inherit" });
if (await run.exited !== 0) process.exit(1);
console.log("Local isolated demo started");
