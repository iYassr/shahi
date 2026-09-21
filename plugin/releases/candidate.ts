import { join } from "node:path";
import { sha256, validateRelease, type Release } from "./catalog";
import definition from "./release.json";

/** Refuse a substituted, stale, or damaged CI artifact before release signing. */
export function verifyCandidate(release: Release, bytes: Uint8Array, commit: string, version: string) {
  validateRelease(release);
  if (release.commit !== commit || release.version !== version) throw new Error("CI candidate does not match the release source.");
  if (release.artifact.bytes !== bytes.length || release.artifact.sha256 !== sha256(bytes)) throw new Error("CI candidate archive failed integrity verification.");
}

if (import.meta.main) {
  const [directory, commit] = process.argv.slice(2);
  if (!directory || !commit) throw new Error("Usage: candidate.ts <directory> <commit>");
  verifyCandidate(await Bun.file(join(directory, "release.json")).json(), await Bun.file(join(directory, "shahi-service.tar.gz")).bytes(), commit, definition.version);
  console.log("Verified the tested candidate matches this release commit and archive digest.");
}
