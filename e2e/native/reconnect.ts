/** Keep a conversation and draft through an isolated encrypted connection outage.
 * Uses only the isolated encrypted fixture. See creation-matrix.ts for setup.
 */
import { SCENARIOS } from "../stub/data";
import { mkdtempSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const device = process.env.SIMULATOR_UDID;
if (!device) throw new Error("Set SIMULATOR_UDID to the Shahi test simulator.");
const port = Number(process.env.HOSTED_PORT ?? 7894);
const relay = `http://127.0.0.1:${port}`;
if (!(await (await fetch(`${relay}/__hosted/ready`)).json()).fixture) throw new Error("Isolated fixture required.");
const pairing = await (await fetch(`${relay}/__hosted/reset`, { method: "POST" })).json();
const scenario = SCENARIOS.busy();
const target = scenario.session.panes[0]!;
Object.assign(target, { agent: "codex", title: "Review this project and summarize every result from a very long conversation", status: "idle", hasPrompt: false, prompt: null });
scenario.session.panes = [target];
scenario.transcripts = { [target.paneId]: [{ id: "recovery-message", role: "agent", at: 1, blocks: [{ kind: "text", text: "Ready for recovery." }] }] };
scenario.prompts = {};
scenario.screens = { [target.paneId]: "Codex terminal is available\nWaiting for your next instruction\n" };
const configured = await fetch(`http://127.0.0.1:${port + 1}/__stub/scenario`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ patch: scenario }) });
if (!configured.ok) throw new Error("Fixture configuration failed.");
const output = mkdtempSync(join(tmpdir(), "shahi-reconnect-"));
const tap = (id: string) => ({ tapOn: { id } });
const faultFile = join(output, "connection.js");
await Bun.write(faultFile, `const response = http.post("${relay}/__hosted/" + MODE, { body: "" }); if (response.status !== 200) throw new Error("Fixture fault failed");`);
const steps: unknown[] = [
  { launchApp: { clearState: true, clearKeychain: true } },
  { tapOn: { text: "Cancel", optional: true } },
  { extendedWaitUntil: { visible: "Connect your computer", timeout: 30000 } },
  { openLink: "${PAIR_CODE}" }, { tapOn: { text: "Open", optional: true } },
  { extendedWaitUntil: { visible: { id: "confirm-pair" }, timeout: 15000 } }, tap("confirm-pair"),
  { extendedWaitUntil: { visible: { id: `row-${target.paneId}` }, timeout: 30000 } }, tap(`row-${target.paneId}`),
  { extendedWaitUntil: { visible: "Ready for recovery.", timeout: 15000 } },
  { tapOn: "Reply to this agent…" }, { inputText: "Keep this unsent draft" }, { tapOn: "Back" }, tap(`row-${target.paneId}`),
  { runScript: { file: faultFile, env: { MODE: "offline" } } },
  { extendedWaitUntil: { visible: "Computer disconnected", timeout: 30000 } },
  { assertVisible: "Ready for recovery." }, { assertVisible: "Keep this unsent draft" },
  { takeScreenshot: "disconnected-with-draft" },
  { tapOn: "Back" }, tap(`row-${target.paneId}`),
  { assertVisible: "Ready for recovery." }, { assertVisible: "Keep this unsent draft" },
  { runScript: { file: faultFile, env: { MODE: "online" } } },
  { extendedWaitUntil: { notVisible: "Computer disconnected", timeout: 60000 } },
  { assertVisible: "Ready for recovery." }, { assertVisible: "Keep this unsent draft" },
  { takeScreenshot: "recovered-with-draft" },
];
const file = join(output, "reconnect.yaml");
await Bun.write(file, `appId: app.shahi.mobile\nname: Conversation recovery\n---\n${JSON.stringify(steps, null, 2)}\n`);
const fd = openSync(join(output, "maestro.log"), "w");
let exit: number;
try { exit = await Bun.spawn(["maestro", "--device", device, "test", "--test-output-dir", output, "-e", `PAIR_CODE=${pairing.code}`, file], { stdout: fd, stderr: fd }).exited; }
finally { closeSync(fd); }
console.log(`Artifacts: ${output}`);
if (exit !== 0) throw new Error("Native reconnect regression failed; inspect maestro.log.");
const writes = await (await fetch(`${relay}/__hosted/writes`)).json();
if (writes.requests?.some((request: { method: string; path: string }) => request.method === "POST" && /\/prompt$/.test(request.path))) throw new Error("Recovery sent an unsent draft.");
console.log("PASS: connection outage, cached conversation, retained draft, reopening offline, automatic recovery, no automatic send.");
