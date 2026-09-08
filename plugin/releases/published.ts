import { sha256, validateRelease, verifyCatalog, type Release } from "./catalog";
import { RELEASE_KEYS } from "./trust";

/** Reuse an immutable package only if its bytes were approved, not just its name. */
export function verifyPublished(release: unknown, rebuilt: Release, bytes: Uint8Array, stable: string, beta: string, keys = RELEASE_KEYS): Release {
  validateRelease(release);
  if (release.commit !== rebuilt.commit || release.version !== rebuilt.version) throw new Error("Released versions are immutable; bump the release version.");
  if (bytes.length !== release.artifact.bytes || sha256(bytes) !== release.artifact.sha256) throw new Error("Published package bytes were changed.");
  if (JSON.stringify(release) === JSON.stringify(rebuilt)) return release;
  const approved = [...verifyCatalog(stable, "stable", 0, keys).releases, ...verifyCatalog(beta, "beta", 0, keys).releases];
  if (!approved.some(r => JSON.stringify(r) === JSON.stringify(release))) throw new Error("The existing package has no matching signed approval. It cannot be promoted.");
  return release;
}

if (import.meta.main) {
  const [published, rebuilt, archive, stable, beta] = process.argv.slice(2);
  if (!published || !rebuilt || !archive || !stable || !beta) throw new Error("Expected published manifest, rebuilt manifest, archive and both channel catalogs.");
  verifyPublished(await Bun.file(published).json(), await Bun.file(rebuilt).json() as Release, await Bun.file(archive).bytes(), await Bun.file(stable).text(), await Bun.file(beta).text());
  console.log("Published package matches its approved bytes and source commit.");
}
