/** Native navigation contract against an isolated encrypted relay, never a live computer.
 * Start HOSTED_PORT=7872 bun e2e/hosted/server.ts, install a release simulator build,
 * then SIMULATOR_UDID=... bun e2e/native/creation-matrix.ts.
 * AGENT_KINDS=claude,codex narrows a diagnostic run; defaults cover herdr's kinds.
 */
import { modesFor } from "../../shared/src/modes";
import { mkdtempSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const device = process.env.SIMULATOR_UDID;
if (!device) throw new Error("Set SIMULATOR_UDID to an installed Shahi simulator.");
const port = Number(process.env.HOSTED_PORT ?? 7872);
const relay = `http://127.0.0.1:${port}`;
const stub = `http://127.0.0.1:${port + 1}`;
const ready = await (await fetch(`${relay}/__hosted/ready`)).json();
if (!ready.fixture) throw new Error("Refusing a server that is not the isolated fixture.");
const kinds = (process.env.AGENT_KINDS ?? "pi,claude,codex,gemini,cursor,devin,agy,cline,omp,mastracode,opencode,copilot,kimi,kiro,droid,amp,grok,hermes,kilo,qodercli,qwen,letta,maki,muse").split(",");
const output = mkdtempSync(join(tmpdir(), "shahi-native-creation-"));
console.log(`Artifacts: ${output}`);
async function post(base: string, path: string, body?: unknown) {
  const response = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(`Fixture ${path}: ${response.status}`);
  return response.json();
}
async function run(name: string, steps: unknown[], env: string[] = []) {
  // JSON is valid YAML and avoids quoting pairing links or shell interpolation.
  const file = join(output, `${name}.yaml`);
  await Bun.write(file, `appId: app.shahi.mobile\nname: ${name}\n---\n${JSON.stringify(steps, null, 2)}\n`);
  const log = Bun.file(join(output, `${name}.log`));
  const fd = openSync(log.name!, "w");
  let exit: number;
  try {
    const child = Bun.spawn(["maestro", "--device", device!, "test", ...env, file], { stdout: fd, stderr: fd });
    exit = await child.exited;
  } finally { closeSync(fd); }
  if (exit !== 0) throw new Error(`${name} failed; see ${log.name}`);
  console.log(`PASS ${name}`);
}
const tap = (id: string) => ({ tapOn: { id } });
const scroll = (id: string) => ({ scrollUntilVisible: { element: { id }, direction: "DOWN" } });
const pairing = await post(relay, "/__hosted/reset");
await run("pair", [
  { launchApp: { clearState: true, clearKeychain: true } },
  { tapOn: { text: "Cancel", optional: true } },
  { extendedWaitUntil: { visible: "Connect your computer", timeout: 30000 } },
  { openLink: "${PAIR_CODE}" },
  { tapOn: { text: "Open", optional: true } },
  { extendedWaitUntil: { visible: { id: "confirm-pair" }, timeout: 15000 } },
  tap("confirm-pair"), { extendedWaitUntil: { visible: "Agents", timeout: 30000 } },
], ["-e", `PAIR_CODE=${pairing.code}`]);
const resetScript = join(output, "reset.js");
const verifyScript = join(output, "verify.js");
await Bun.write(resetScript, `
var response = http.post(${JSON.stringify(stub + "/__stub/scenario")}, {
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "busy", patch: { agents: ${JSON.stringify(kinds)}, createAgents: true } })
});
if (!response.ok) throw new Error("Fixture reset failed: " + response.status);
`);
await Bun.write(verifyScript, `
var response = http.get(${JSON.stringify(stub + "/__stub/writes")});
var starts = json(response.body).writes.filter(w => w.path === "/api/agents/start");
var mode = MODE === "none" ? null : MODE;
if (starts.length !== 1 || starts[0].body.kind !== KIND || starts[0].body.workspaceId !== "w1" || starts[0].body.mode !== mode) {
  throw new Error("Wrong creation payload: " + JSON.stringify(starts));
}
`);
const matrix: unknown[] = [];
let count = 0;
for (const entry of ["agents", "spaces"]) {
  for (const kind of kinds) {
    const modes = modesFor(kind);
    for (const mode of modes.length ? modes : [{ id: "default" }]) {
      const steps: unknown[] = [{ runScript: { file: resetScript, env: { KIND: kind } } }, { tapOn: entry === "agents" ? "Agents" : "Spaces" }];
      if (entry === "agents") steps.push(
        { scrollUntilVisible: { element: { id: "new-agent" }, direction: "UP" } },
        { waitForAnimationToEnd: { timeout: 1000 } }, tap("new-agent"), tap("pick-w1"),
      );
      else steps.push(tap("space-w1"), scroll("space-new-agent"), tap("space-new-agent"));
      steps.push(scroll(`agent-kind-${kind}`), tap(`agent-kind-${kind}`));
      if (modes.length) steps.push(scroll(`agent-mode-${mode.id}`), tap(`agent-mode-${mode.id}`));
      steps.push(scroll("start-agent"), tap("start-agent"),
        { extendedWaitUntil: { visible: { id: "view-read" }, timeout: 15000 } },
        { assertVisible: `New ${kind} [0-9]+` },
        { assertNotVisible: "Choose a space" },
        { takeScreenshot: `${entry}-${kind}-${mode.id}` }, { tapOn: "Back" });
      if (entry === "spaces") steps.push({ assertVisible: { id: "space-new-agent" } }, { tapOn: "Back" });
      steps.push({ runScript: { file: verifyScript, env: { KIND: kind, MODE: modes.length ? mode.id : "none" } } });
      matrix.push(...steps);
      count++;
    }
  }
}
await run("creation-matrix", matrix);
console.log(`Passed ${count} creation/navigation cases, with one matching request each.`);
