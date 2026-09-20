/** Opt-in, disposable systemd user service using the plugin's actual unit template. */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, basename } from "node:path";
import { renderSystemd } from "../../plugin/service";
import { fromSeed } from "../lib/identity";
import { RelayLink } from "../../shared/src/relay-client";

if (process.env.SHAHI_LIVE_RELAY_RECOVERY !== "1") throw new Error("Explicit live-test opt-in required");
const root = new URL("../../", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "shahi-supervision-"));
const unitName = `${basename(dir)}.service`;
const unitDir = join(homedir(), ".config/systemd/user"); mkdirSync(unitDir, { recursive: true });
const unitPath = join(unitDir, unitName);
const configPath = join(dir, "private.json");
const events = join(dir, "events"); writeFileSync(events, "");
const seed = crypto.getRandomValues(new Uint8Array(32));
const secret = crypto.getRandomValues(new Uint8Array(32));
const url = process.env.SHAHI_TEST_RELAY ?? "https://relay.getshahi.dev";
writeFileSync(configPath, JSON.stringify({ seed: [...seed], secret: [...secret], url, events }), { mode: 0o600 });
writeFileSync(unitPath, renderSystemd({ bun: process.execPath, root, entry: "server/scripts/verify-relay-recovery.ts", env: { SHAHI_RECOVERY_CHILD: configPath }, logPath: join(dir, "service.log") }));
function systemctl(...args: string[]) {
  const result = Bun.spawnSync(["systemctl", "--user", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(`systemctl ${args[0]} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}
const connected = () => readFileSync(events, "utf8").split("relay.connected").length - 1;
async function until(check: () => boolean) {
  const deadline = Date.now() + 60000;
  while (!check() && Date.now() < deadline) await Bun.sleep(100);
  if (!check()) throw new Error("Supervision recovery deadline exceeded");
}
const phone = new RelayLink({ relay: url, serverId: fromSeed(seed).serverId, auth: { kind: "device", deviceId: "recovery-probe" }, secret });
async function probe() {
  phone.ensureConnected(); await until(() => phone.state === "live");
  const result = await phone.request({ method: "GET", path: "/api/meta", headers: {}, body: null }, 15000);
  if ((await result.json() as {probe?:string}).probe !== "recovery-ok") throw new Error("Encrypted probe failed");
}
try {
  systemctl("daemon-reload"); systemctl("start", unitName);
  await until(() => connected() > 0); await probe();
  const before = connected(); const pid = Number(systemctl("show", unitName, "--property=MainPID", "--value"));
  if (pid <= 1) throw new Error("No isolated service PID");
  process.kill(pid, "SIGKILL");
  await until(() => connected() > before); await probe();
  const next = Number(systemctl("show", unitName, "--property=MainPID", "--value"));
  if (next === pid || next <= 1) throw new Error("Service did not restart");
  console.log("PASS plugin systemd template restarts a killed service and restores encrypted relay requests with the same pairing");
} finally {
  phone.close();
  try { systemctl("stop", unitName); } finally {
    rmSync(unitPath, { force: true }); systemctl("daemon-reload"); rmSync(dir, { recursive: true, force: true });
  }
}
