// Records the phone cut's footage from the real app: the Release build on an
// iPhone 17 Pro Max simulator, paired with the encrypted fixture on the
// showcase scenario (invented projects and agents, never a real session).
//
//   HOSTED_PORT=7572 bun e2e/hosted/server.ts          (in another terminal, from the repository root)
//   bun marketing/video/capture/capture.ts [udid]      (from the repository root)
//
// Writes marketing/video/public/phone/<name>.mp4 (30 fps, 660 × 1434, the
// screen at half its pixels) and <name>.png stills. Each clip is cut to start
// half a second before its first movement, and the script prints when every
// later movement begins: src/phone/timeline.ts places taps and cuts on those
// frames, so a new capture means reading them again.
//
// Simulator setup is marketing/app-store/README.md's (signed Release build,
// status bar at 9:41, dark appearance, no hardware keyboard), plus Maestro and
// a full ffmpeg (`brew install ffmpeg`): the one Remotion ships has no raw
// output to measure movement with. The capture ends paired and in English,
// ready to run again.

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const UDID = process.argv[2] ?? "2B5E926C-748D-481A-BDBA-FAF794CBF97B";
const ROOT = join(import.meta.dirname, "../../..");
const VIDEO = join(ROOT, "marketing/video");
const OUT = join(VIDEO, "public/phone");
const FLOWS = join(import.meta.dirname, "flows");
const STORE_FLOWS = join(ROOT, "marketing/app-store/flows");
const STUB = "http://127.0.0.1:7573";
const CONTROL = readFileSync(join(ROOT, "marketing/app-store/control.json"), "utf8");
const FPS = 30;
const WIDTH = 660;

const tmp = mkdtempSync(join(tmpdir(), "shahi-capture-"));
mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(cmd: string[], cwd = ROOT) {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if ((await p.exited) !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} failed:\n${out}\n${err}`);
  return out;
}

async function flow(file: string, env: Record<string, string> = {}) {
  const args = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  await run(["maestro", "--device", UDID, "test", ...args, file]);
}

async function stub(path: string, body: string) {
  const res = await fetch(`${STUB}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body });
  if (!res.ok) throw new Error(`the fixture answered ${res.status} to ${path}; is e2e/hosted/server.ts running on 7572?`);
}

/** A scenario change clears the handshake, which hides Changes; it is posted again after every one. */
async function scenario(body: object) {
  await stub("/__stub/scenario", JSON.stringify(body));
  await stub("/__stub/control", CONTROL);
}

const ffmpeg = (args: string[]) => run(["ffmpeg", "-v", "error", "-y", ...args], VIDEO);

/**
 * When the picture moves, in frames: a low-resolution grey copy compared frame
 * by frame. The status bar is held at 9:41, so between actions nothing changes
 * at all, and any change is the app responding.
 */
async function onsets(file: string) {
  const w = 110, h = 239;
  const p = Bun.spawn(["ffmpeg", "-v", "error", "-i", file, "-s", `${w}x${h}`, "-r", String(FPS), "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1"], { cwd: VIDEO, stdout: "pipe" });
  const bytes = new Uint8Array(await new Response(p.stdout).arrayBuffer());
  const n = Math.floor(bytes.length / (w * h));
  const starts: number[] = [];
  let quiet = 99;
  for (let f = 1; f < n; f++) {
    let d = 0;
    for (let i = 0; i < w * h; i++) d += Math.abs(bytes[f * w * h + i] - bytes[(f - 1) * w * h + i]);
    const moving = d / (w * h) > 0.35;
    if (moving && quiet >= 6) starts.push(f);
    quiet = moving ? 0 : quiet + 1;
  }
  return { starts, frames: n };
}

async function clip(name: string, file: string, after?: () => Promise<void>, env?: Record<string, string>) {
  const raw = join(tmp, `${name}.mp4`);
  const rec = Bun.spawn(["xcrun", "simctl", "io", UDID, "recordVideo", "--codec", "h264", "--mask", "black", "--force", raw], { stdout: "pipe", stderr: "pipe" });
  let said = "";
  const listen = async (s: ReadableStream<Uint8Array>) => { for await (const c of s) said += new TextDecoder().decode(c); };
  void listen(rec.stdout); void listen(rec.stderr);
  for (let i = 0; i < 100 && !said.includes("Recording started"); i++) await sleep(100);
  await sleep(800);
  await flow(file, env);
  await after?.();
  await sleep(1500);
  rec.kill("SIGINT");
  await rec.exited;

  const { starts } = await onsets(raw);
  if (!starts.length) throw new Error(`Nothing moved in the ${name} recording.`);
  const lead = Math.max(0, starts[0] - FPS / 2);
  const out = join(OUT, `${name}.mp4`);
  // The first picture at time 0: Remotion seeks by timestamp, and a cut made with
  // -ss alone kept the source's own start (up to half a second in), so clip
  // frame n, as counted here, showed on Remotion's frame n plus that.
  await ffmpeg(["-ss", (lead / FPS).toFixed(3), "-i", raw, "-an", "-vf", `setpts=PTS-STARTPTS,scale=${WIDTH}:-2:flags=lanczos`, "-r", String(FPS), "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]);
  const after_ = await onsets(out);
  console.log(`  ${name}.mp4  ${(after_.frames / FPS).toFixed(1)}s; movement begins at frames ${after_.starts.join(", ")}`);
}

async function still(name: string) {
  const raw = join(tmp, `${name}.png`);
  await run(["xcrun", "simctl", "io", UDID, "screenshot", "--mask", "black", raw]);
  await ffmpeg(["-i", raw, "-vf", `scale=${WIDTH}:-2:flags=lanczos`, join(OUT, `${name}.png`)]);
  console.log(`  ${name}.png`);
}

const f = (name: string) => join(FLOWS, `${name}.yaml`);

console.log("First launch, and SSH");
await flow(f("fresh"));
await still("connect");
await clip("ssh", f("ssh"));

console.log("Pairing with the fixture");
await flow(join(STORE_FLOWS, "pair.yaml"));
await stub("/__stub/control", CONTROL);
await flow(join(STORE_FLOWS, "relaunch.yaml"));
await sleep(2000);
await still("agents");

console.log("Footage");
await clip("answer", f("answer"), async () => {
  // "Answer sent" shows until the computer moves on; here it moves on as herdr would.
  await sleep(1200);
  await run(["bun", join(import.meta.dirname, "stub.ts"), "answered"]);
  await sleep(1500);
});
await scenario({ name: "showcase" });
await sleep(2500);
await clip("reader", f("reader"));
await clip("changes", f("changes"));
await flow(f("done"));
await flow(f("read"));
await clip("slash", f("slash"));
await flow(f("back"));
await flow(f("agents"));
await clip("new-agent", f("new-agent"));
await flow(f("close-sheet"));
await clip("spaces", f("spaces"));
await flow(f("back"));
await flow(f("usage"));
await still("usage");
for (const [name, language] of [["arabic", "العربية"], ["spanish", "Español"]]) {
  await flow(f("language"), { LANGUAGE: language });
  await sleep(1500);
  await still(name);
}
await flow(f("language"), { LANGUAGE: "English" });
rmSync(tmp, { recursive: true });
console.log(`Done: ${OUT}`);
