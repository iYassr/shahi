/**
 * The first build step of `herdr plugin install`: refuse a bun too old for
 * Shahi before anything is downloaded, and say which bun and how to fix it.
 *
 * plugin/bun.sh runs whatever bun it finds and never upgrades one, so an old
 * bun used to pass every build step and fail later, in the pair popup or the
 * plugin log, with "The computer's installer needs an update", which named
 * neither bun nor a version (pre-public-release review). It imports nothing
 * that needs `bun install`, because it runs first.
 */
import definition from "./release.json";
import { compareVersion } from "./version";

export function bunRequirement(have: string, need: string, path: string): string | null {
  if (compareVersion(have, need) >= 0) return null;
  return `Shahi needs bun ${need} or newer, and this install is running bun ${have} (${path}).\n` +
    "Upgrade it (bun upgrade, or brew upgrade bun if Homebrew installed it), then run:  herdr plugin install iYassr/shahi";
}

if (import.meta.main) {
  const problem = bunRequirement(Bun.version, definition.bun, process.execPath);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
}
