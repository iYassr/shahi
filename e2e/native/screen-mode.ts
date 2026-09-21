/** Screen must remain reachable for a Codex pane with no transcript and a long title.
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
scenario.transcripts = {};
scenario.prompts = {};
scenario.screens = { [target.paneId]: "Codex terminal is available\nWaiting for your next instruction\n" };
const configured = await fetch(`http://127.0.0.1:${port + 1}/__stub/scenario`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ patch: scenario }) });
if (!configured.ok) throw new Error("Fixture configuration failed.");
const output = mkdtempSync(join(tmpdir(), "shahi-screen-mode-"));
const tap = (id: string) => ({ tapOn: { id } });
const screen = { assertVisible: "Codex terminal is available.*" };
const steps: unknown[] = [
  { launchApp: { clearState: true, clearKeychain: true } },
  { tapOn: { text: "Cancel", optional: true } },
  { extendedWaitUntil: { visible: "Connect your computer", timeout: 30000 } },
  { openLink: "${PAIR_CODE}" }, { tapOn: { text: "Open", optional: true } },
  { extendedWaitUntil: { visible: { id: "confirm-pair" }, timeout: 15000 } }, tap("confirm-pair"),
  { extendedWaitUntil: { visible: { id: `row-${target.paneId}` }, timeout: 30000 } }, tap(`row-${target.paneId}`),
  { extendedWaitUntil: { visible: "Nothing to read yet.", timeout: 15000 } },
  { takeScreenshot: "empty-read" }, tap("view-screen"), screen,
  { takeScreenshot: "screen" }, tap("view-read"),
  { assertVisible: "Nothing to read yet." }, { tapOn: "Show the screen instead" }, screen,
];
for (let n = 0; n < 3; n++) steps.push(tap("view-read"), { assertVisible: "Nothing to read yet." }, tap("view-screen"), screen);
steps.push({ tapOn: "Back" }, tap(`row-${target.paneId}`), screen, { takeScreenshot: "reopened-screen" });
const file = join(output, "screen-mode.yaml");
await Bun.write(file, `appId: app.shahi.mobile\nname: Codex Screen access\n---\n${JSON.stringify(steps, null, 2)}\n`);
const fd = openSync(join(output, "maestro.log"), "w");
let exit: number;
try { exit = await Bun.spawn(["maestro", "--device", device, "test", "--test-output-dir", output, "-e", `PAIR_CODE=${pairing.code}`, file], { stdout: fd, stderr: fd }).exited; }
finally { closeSync(fd); }
console.log(`Artifacts: ${output}`);
if (exit !== 0) throw new Error("Native Screen regression failed; inspect maestro.log.");
console.log("PASS: header-independent controls, empty transcript, repeated mode changes and reopening Screen.");
