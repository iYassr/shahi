import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { download, sha256, type Release } from "./catalog";
import { atomicJson, releaseDirectory } from "./storage";

/** Every archive byte is approved before it is interpreted or written. */
export async function stage(root: string, release: Release, fetchBytes = download): Promise<string> {
  const destination = releaseDirectory(root, release);
  if (existsSync(join(destination, "verified.json"))) {
    if (readFileSync(join(destination, "verified.json"), "utf8") === JSON.stringify(release)) return destination;
    throw new Error("A release identifier was reused with different contents.");
  }
  const bytes = await fetchBytes(release.artifact.url, release.artifact.bytes);
  if (bytes.length !== release.artifact.bytes || sha256(bytes) !== release.artifact.sha256) throw new Error("Release download failed integrity verification.");
  const temporary = `${destination}.staging`;
  rmSync(temporary, { recursive: true, force: true }); mkdirSync(temporary, { recursive: true, mode: 0o700 });
  try {
    const files = await new Bun.Archive(bytes).files();
    if (files.size > 5000 || !files.has("service.js") || !files.has("manager.js") || !files.has("web/index.html")) throw new Error("Incomplete release archive.");
    let size = 0;
    for (const [path, file] of files) {
      if (!(path === "service.js" || path === "manager.js" || path.startsWith("web/")) || path.includes("\\") || path.split("/").some(p => !p || p === "." || p === "..") || /[\x00-\x1f]/.test(path)) throw new Error("Unsafe release archive path.");
      size += file.size; if (size > 128 * 1024 * 1024) throw new Error("Release expands beyond its size limit.");
      await Bun.write(join(temporary, path), file);
    }
    atomicJson(join(temporary, "verified.json"), release);
    renameSync(temporary, destination);
    return destination;
  } catch (e) { rmSync(temporary, { recursive: true, force: true }); throw e; }
}
