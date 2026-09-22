import { readFileSync } from "node:fs";
import { sign } from "node:crypto";
import type { ReleaseChannel } from "@shahi/shared";
import { MAX_RELEASES, compareVersion, supportsHerdr, validateRelease, verifyCatalog, type Catalog, type Release } from "./catalog";

/** A catalog's life. Renewal (catalog-expiry.yml) re-signs a channel well before this runs out. */
export const CATALOG_LIFETIME_MS = 120 * 86400_000;

/**
 * True when no computer could ever select `older`, because `newer` would be
 * chosen first on every machine `older` suits: a newer version that runs
 * everywhere it runs (platforms, herdr profiles, bun), keeps its data format,
 * and asks no more of the installed API than it does. selectRelease takes the
 * newest compatible entry, so dropping `older` changes no selection.
 */
function supersedes(newer: Release, older: Release): boolean {
  return compareVersion(newer.version, older.version) > 0 && newer.dataSchema === older.dataSchema &&
    newer.api.min <= older.api.min && compareVersion(newer.bun, older.bun) <= 0 &&
    older.platforms.every(p => newer.platforms.includes(p)) && older.herdr.every(h => supportsHerdr(newer, h));
}

/**
 * The next signed payload for a channel: `release` added (or none, to renew),
 * `retire` withdrawn, superseded entries dropped.
 *
 * Every earlier release used to be carried forever, and verifyCatalog refuses
 * more than MAX_RELEASES, so the 51st signing would have failed with no way
 * to ship even a security fix, and a vulnerable old release could not be
 * withdrawn at all (pre-public-release review). Entries that still serve a
 * herdr, bun or platform no newer release covers are kept; `retire` is the
 * explicit way to withdraw one that is unsafe.
 */
export function nextCatalog(channel: ReleaseChannel, previous: Catalog | null, release: Release | null, { now = Date.now(), retire = [] as string[] } = {}): Catalog {
  const prior = previous?.releases ?? [];
  if (release) {
    validateRelease(release);
    if (channel === "stable" && release.version.includes("-")) throw new Error("A beta build cannot enter Stable.");
    if (prior.some(r => r.version === release.version && JSON.stringify(r) !== JSON.stringify(release))) throw new Error("Released versions are immutable.");
    if (retire.includes(release.version)) throw new Error(`Shahi ${release.version} cannot be approved and retired at once.`);
  } else if (!previous) throw new Error("Renewal needs the channel's current catalog.");
  const unknown = retire.filter(v => !prior.some(r => r.version === v));
  if (unknown.length) throw new Error(`Cannot retire ${unknown.join(", ")}: not in the ${channel} catalog.`);
  const candidates = (release ? [release, ...prior.filter(r => r.version !== release.version)] : prior).filter(r => !retire.includes(r.version));
  const releases = candidates
    .sort((a, b) => compareVersion(b.version, a.version))
    .filter((r, i, ordered) => !ordered.slice(0, i).some(newer => supersedes(newer, r)));
  if (!releases.length) throw new Error("A catalog needs at least one approved release.");
  // Approving a release that a newer one already supersedes would sign a
  // catalog without it and report success; say so instead.
  if (release && !releases.includes(release)) throw new Error(`Shahi ${release.version} is superseded by a newer release in the ${channel} catalog; no computer would select it.`);
  if (releases.length > MAX_RELEASES) {
    throw new Error(`${releases.length} releases are still selectable, more than the ${MAX_RELEASES} a computer accepts. Retire the oldest explicitly.`);
  }
  return {
    schema: 1, channel,
    sequence: Math.max(now, (previous?.sequence ?? 0) + 1),
    publishedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CATALOG_LIFETIME_MS).toISOString(),
    releases,
  };
}

export function signCatalog(catalog: Catalog, privateKey: string | Buffer, keyId = "shahi-2026"): string {
  const payload = Buffer.from(JSON.stringify(catalog));
  return JSON.stringify({ keyId, payload: payload.toString("base64"), signature: sign(null, payload, privateKey).toString("base64") });
}

/**
 * The channel's current catalog, expired or not. Expiry protects computers
 * from a frozen feed; it must not stop the signer carrying the approved
 * history forward, or a channel that lapsed could never be signed again
 * without a code change. Signature, channel and schema are still verified.
 */
export function previousCatalog(text: string, channel: ReleaseChannel, keys?: Record<string, string>): Catalog {
  return verifyCatalog(text, channel, 0, keys, Date.now(), { allowExpired: true });
}

/** Days left before a catalog expires, negative once it has. */
export const daysLeft = (catalog: Catalog, now = Date.now()) => (Date.parse(catalog.expiresAt) - now) / 86400_000;

const USAGE = [
  "sign.ts stable|beta <release.json> <private-key.pem> <catalog.json> [previous-catalog.json] [--retire v1,v2]",
  "sign.ts renew stable|beta <private-key.pem> <catalog.json> <previous-catalog.json> [--retire v1,v2]",
  "sign.ts due stable|beta <catalog.json> <days>     prints true when the catalog expires within <days>",
].join("\n  ");

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = argv.indexOf("--retire");
  const retire = flag < 0 ? [] : (argv.splice(flag, 2)[1] ?? "").split(",").map(v => v.trim()).filter(Boolean);
  const channel = (argv[0] === "renew" || argv[0] === "due" ? argv[1] : argv[0]) as ReleaseChannel;
  if (channel !== "stable" && channel !== "beta") throw new Error(`Usage:\n  ${USAGE}`);
  if (argv[0] === "due") {
    const [, , file, days] = argv;
    if (!file || !days || !Number.isFinite(Number(days))) throw new Error(`Usage:\n  ${USAGE}`);
    const catalog = previousCatalog(readFileSync(file, "utf8"), channel);
    const left = daysLeft(catalog);
    console.error(`${channel} catalog: sequence ${catalog.sequence}, ${catalog.releases.length} release(s), expires ${catalog.expiresAt} (${left.toFixed(1)} days).`);
    console.log(left < Number(days) ? "true" : "false");
  } else {
    const renewing = argv[0] === "renew";
    const [releaseFile, keyFile, output, previousFile] = renewing ? [null, ...argv.slice(2)] : argv.slice(1);
    if (!keyFile || !output || (renewing && !previousFile)) throw new Error(`Usage:\n  ${USAGE}`);
    const release: unknown = releaseFile ? JSON.parse(readFileSync(releaseFile, "utf8")) : null;
    if (release !== null) validateRelease(release);
    const previous = previousFile ? previousCatalog(readFileSync(previousFile, "utf8"), channel) : null;
    const catalog = nextCatalog(channel, previous, release as Release | null, { retire });
    const envelope = signCatalog(catalog, readFileSync(keyFile));
    verifyCatalog(envelope, channel, previous?.sequence ?? 0);
    await Bun.write(output, envelope + "\n");
    console.log(`Signed ${channel} catalog with ${catalog.releases.length} approved release(s), expiring ${catalog.expiresAt}.`);
  }
}
