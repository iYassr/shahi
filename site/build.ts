/** Build the public website and the independently hosted encrypted client. */
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const run = Bun.spawn([process.execPath, "run", "--cwd", "web", "build", "--mode", "hosted"], {
  cwd: root, stdout: "inherit", stderr: "inherit",
});
if (await run.exited !== 0) process.exit(1);
await rm(new URL("./dist", import.meta.url), { recursive: true, force: true });
await mkdir(new URL("./dist", import.meta.url), { recursive: true });
await cp(new URL("./public", import.meta.url), new URL("./dist", import.meta.url), { recursive: true });
await cp(new URL("../web/dist-hosted", import.meta.url), new URL("./dist/pwa", import.meta.url), { recursive: true });


await cp(new URL("../web/public/welcome.js", import.meta.url), new URL("./dist/welcome.js", import.meta.url));

await cp(new URL("../web/public/identity.css", import.meta.url), new URL("./dist/identity.css", import.meta.url));
console.log("Built site/dist with shared identity and the browser app at /pwa/.");
