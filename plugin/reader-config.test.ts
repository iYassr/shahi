import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serviceSpec } from "./shahi";
import { launchdEnvironment, renderLaunchd, renderSystemd, systemdEnvironment } from "./service";
import { readEnvFile } from "../server/lib/secrets";

// The original Reader test set process.env directly, bypassing the installed
// service that lost this value. Start a fresh reader with only the environment
// that launchd/systemd receives, from a working directory without a .env file.
for (const source of ["shell", "file", "file overrides shell"] as const) {
  test(`installed Claude Reader preserves its ${source} configuration`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "shahi-reader-service-")));
    const previous = process.env.CLAUDE_CONFIG_DIR;
    try {
      const configDir = join(root, "Claude history & images");
      const project = join(configDir, "projects", "fixture");
      const managed = join(root, "managed");
      await mkdir(project, { recursive: true });
      await mkdir(managed);
      const sessionId = crypto.randomUUID();
      const transcript = join(project, `${sessionId}.jsonl`);
      await writeFile(transcript, JSON.stringify({ type: "user", uuid: "image-1", message: { content: [
        { type: "text", text: "Only this configured conversation." },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
      ] } }) + "\n");
      const envFile = join(root, "service.env");
      await writeFile(envFile, source === "shell" ? "" : `CLAUDE_CONFIG_DIR="${configDir}"\n`);
      if (source === "file") delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = source === "shell" ? configDir : join(root, "wrong-account");
      const spec = serviceSpec({
        root: managed, configDir: root, stateDir: root, envFile,
        dataPath: join(root, "state.sqlite"), logPath: join(root, "service.log"),
        webRoot: join(root, "web"), socketPath: join(root, "unused.sock"),
      }, readEnvFile(envFile), process.execPath);

      for (const env of [launchdEnvironment(renderLaunchd(spec)), systemdEnvironment(renderSystemd(spec))]) {
        expect(env.CLAUDE_CONFIG_DIR).toBe(configDir);
        const child = Bun.spawn([process.execPath, "--eval", `
          import { findTranscript, readWindow, readSessionImage } from ${JSON.stringify(join(import.meta.dir, "../server/lib/session-log.ts"))};
          const id = ${JSON.stringify(sessionId)};
          const path = await findTranscript(id);
          const image = await readSessionImage(id, "image-1:0");
          console.log(JSON.stringify({ path, log: path ? await readWindow(path) : null,
            image: image && { mediaType: image.mediaType, bytes: Buffer.from(image.bytes).toString() } }));
        `], { cwd: managed, env, stdout: "pipe", stderr: "pipe" });
        const [out, err, code] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        expect(err).toBe("");
        expect(code).toBe(0);
        const result = JSON.parse(out);
        expect(result.path).toBe(transcript);
        expect(JSON.stringify(result.log)).toContain("Only this configured conversation.");
        expect(result.image).toEqual({ mediaType: "image/png", bytes: "hello" });
      }
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("an explicitly empty Claude folder clears the inherited override", () => {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = "/another-account/claude";
    const spec = serviceSpec({ root: "/plugin", configDir: "/config", stateDir: "/state", envFile: "/config/.env",
      dataPath: "/state/db", logPath: "/state/log", webRoot: "/plugin/web", socketPath: "/unused.sock" },
    new Map([["CLAUDE_CONFIG_DIR", ""]]), process.execPath);
    expect(launchdEnvironment(renderLaunchd(spec)).CLAUDE_CONFIG_DIR).toBe("");
    expect(systemdEnvironment(renderSystemd(spec)).CLAUDE_CONFIG_DIR).toBe("");
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});
