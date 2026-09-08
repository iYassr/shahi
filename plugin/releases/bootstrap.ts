import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { HerdrClient } from "../../server/lib/herdr-client";
import type { Layout } from "../layout";
import { CATALOG_URL, download, selectRelease, verifyCatalog } from "./catalog";
import { atomicJson, installation, releaseDirectory } from "./storage";
import { stage } from "./stage";

/** The plugin manages a supervisor; approved service builds live outside it. */
export async function bootstrap(layout: Layout) {
  const root = join(layout.stateDir, "managed");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!installation(root)) {
    const raw = Buffer.from(await download(CATALOG_URL("stable"), 256 * 1024)).toString("utf8");
    const catalog = verifyCatalog(raw, "stable");
    let herdr = null;
    try { herdr = await new HerdrClient({ socketPath: layout.socketPath }).rpc("ping", {}); } catch { /* Install recovery while herdr is away. */ }
    const result = selectRelease(catalog, { platform: `${process.platform}-${process.arch}`, bun: Bun.version, herdr });
    if (!result.release) throw new Error(result.reason ?? "No approved release supports this computer.");
    await stage(root, result.release);
    atomicJson(join(root, "installation.json"), { active: result.release, channel: "stable", sequence: { stable: catalog.sequence } });
  }
  // Atomic replacement: a reinstall cannot truncate the running supervisor.
  const approved = installation(root)!.active;
  await Bun.write(join(root, "manager.next.js"), Bun.file(join(releaseDirectory(root, approved), "manager.js")));
  renameSync(join(root, "manager.next.js"), join(root, "manager.js"));
  atomicJson(join(layout.configDir, "managed-root.json"), root);
  return root;
}
