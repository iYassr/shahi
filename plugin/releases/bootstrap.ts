import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { HerdrClient } from "../../server/lib/herdr-client";
import type { Layout } from "../layout";
import { CATALOG_URL, download, herdrProfiles, selectRelease, verifyCatalog, type Catalog, type Machine, type Release } from "./catalog";
import { atomicJson, installation, releaseDirectory } from "./storage";
import { stage } from "./stage";

/**
 * The release a first install runs, and what to tell the person about it.
 *
 * A herdr that no release has been approved for gets the newest release
 * anyway, exactly as an offline herdr always has: the service then runs in
 * its documented recovery state (pairing and updates work, agent commands are
 * refused until an approved Shahi or herdr arrives), and the app offers the
 * approved update when it is published. Refusing instead meant every new user
 * was turned away from the day herdr shipped a release until Shahi signed one
 * (pre-public-release review). Platform and bun stay hard requirements: a
 * build that cannot run is not a recovery state.
 */
export function firstRelease(catalog: Catalog, machine: Machine): { release: Release; notice?: string } {
  const approved = selectRelease(catalog, machine);
  if (approved.release) return { release: approved.release };
  const recovery = machine.herdr ? selectRelease(catalog, { ...machine, herdr: null }) : approved;
  if (!recovery.release) throw new Error(recovery.reason ?? "No approved Shahi release supports this computer.");
  const { release } = recovery;
  return {
    release,
    notice: `Shahi ${release.version} is approved for herdr ${herdrProfiles(release)}, and this computer runs herdr ${machine.herdr!.version} (protocol ${machine.herdr!.protocol}). ` +
      "Shahi is installed so a phone can pair now; agents stay out of reach until the two match. The app offers a Shahi update once one is approved for this herdr; installing an approved herdr also works.",
  };
}

/** The plugin manages a supervisor; approved service builds live outside it. */
export async function bootstrap(layout: Layout): Promise<{ root: string; notice?: string }> {
  const root = join(layout.stateDir, "managed");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let notice: string | undefined;
  if (!installation(root)) {
    const raw = Buffer.from(await download(CATALOG_URL("stable"), 256 * 1024)).toString("utf8");
    const catalog = verifyCatalog(raw, "stable");
    let herdr = null;
    try { herdr = await new HerdrClient({ socketPath: layout.socketPath }).rpc("ping", {}); } catch { /* Install recovery while herdr is away. */ }
    const chosen = firstRelease(catalog, { platform: `${process.platform}-${process.arch}`, bun: Bun.version, herdr });
    notice = chosen.notice;
    await stage(root, chosen.release);
    atomicJson(join(root, "installation.json"), { active: chosen.release, channel: "stable", sequence: { stable: catalog.sequence } });
  }
  // Atomic replacement: a reinstall cannot truncate the running supervisor.
  const approved = installation(root)!.active;
  await Bun.write(join(root, "manager.next.js"), Bun.file(join(releaseDirectory(root, approved), "manager.js")));
  renameSync(join(root, "manager.next.js"), join(root, "manager.js"));
  atomicJson(join(layout.configDir, "managed-root.json"), root);
  return { root, ...(notice ? { notice } : {}) };
}
