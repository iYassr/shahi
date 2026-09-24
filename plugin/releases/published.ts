import { sha256, validateRelease, verifyCatalog, type Release } from "./catalog";
import { RELEASE_KEYS } from "./trust";

/**
 * Reuse an immutable package only if its bytes were approved, not just its name.
 *
 * A Stable run promotes the package Beta already approved, so the commit master
 * has moved on to since then is not the package's commit, and must not block it:
 * 0.3.7's first promotion failed here because two docs commits had landed after
 * its Beta. What is promoted is still the published bytes, and only if a signed
 * catalog approved exactly that manifest. A Beta run with changed code and the
 * same version is still refused: that is a missed version bump.
 */
export function verifyPublished(release: unknown, rebuilt: Release, bytes: Uint8Array, stable: string, beta: string, keys = RELEASE_KEYS, channel: "stable" | "beta" = "beta"): Release {
  validateRelease(release);
  if (release.version !== rebuilt.version) throw new Error("Released versions are immutable; bump the release version.");
  if (bytes.length !== release.artifact.bytes || sha256(bytes) !== release.artifact.sha256) throw new Error("Published package bytes were changed.");
  if (JSON.stringify(release) === JSON.stringify(rebuilt)) return release;
  if (release.commit !== rebuilt.commit && channel !== "stable") throw new Error("Released versions are immutable; bump the release version.");
  // "Was this package ever approved" does not expire with the catalog that
  // says so; refusing an expired one here blocked promotion after a lapse.
  const now = Date.now(), lapsed = { allowExpired: true };
  const approved = [...verifyCatalog(stable, "stable", 0, keys, now, lapsed).releases, ...verifyCatalog(beta, "beta", 0, keys, now, lapsed).releases];
  if (!approved.some(r => JSON.stringify(r) === JSON.stringify(release))) throw new Error("The existing package has no matching signed approval. It cannot be promoted.");
  return release;
}

if (import.meta.main) {
  const [published, rebuilt, archive, stable, beta] = process.argv.slice(2);
  if (!published || !rebuilt || !archive || !stable || !beta) throw new Error("Expected published manifest, rebuilt manifest, archive and both channel catalogs.");
  const channel = process.env.RELEASE_CHANNEL === "stable" ? "stable" : "beta";
  verifyPublished(await Bun.file(published).json(), await Bun.file(rebuilt).json() as Release, await Bun.file(archive).bytes(), await Bun.file(stable).text(), await Bun.file(beta).text(), RELEASE_KEYS, channel);
  console.log("Published package matches its approved bytes and source commit.");
}
