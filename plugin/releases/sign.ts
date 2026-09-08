import { readFileSync } from "node:fs";
import { sign } from "node:crypto";
import { validateRelease, verifyCatalog, type Catalog, type Release } from "./catalog";

const [channel, releaseFile, keyFile, output, previousFile] = process.argv.slice(2);
if ((channel !== "stable" && channel !== "beta") || !releaseFile || !keyFile || !output) throw new Error("Usage: sign.ts stable|beta release.json private-key.pem catalog.json [previous-catalog.json]");
const release: unknown = JSON.parse(readFileSync(releaseFile, "utf8")); validateRelease(release);
if (channel === "stable" && release.version.includes("-")) throw new Error("A beta build cannot enter Stable.");
const previous = previousFile ? verifyCatalog(readFileSync(previousFile, "utf8"), channel) : null;
const prior = previous?.releases ?? [];
if (prior.some(r => r.version === release.version && JSON.stringify(r) !== JSON.stringify(release))) throw new Error("Released versions are immutable.");
const releases: Release[] = [release, ...prior.filter(r => r.version !== release.version)];
const catalog: Catalog = { schema: 1, channel, sequence: Math.max(Date.now(), (previous?.sequence ?? 0) + 1), publishedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120 * 86400_000).toISOString(), releases };
const payload = Buffer.from(JSON.stringify(catalog));
const envelope = JSON.stringify({ keyId: "shahi-2026", payload: payload.toString("base64"), signature: sign(null, payload, readFileSync(keyFile)).toString("base64") });
verifyCatalog(envelope, channel);
await Bun.write(output, envelope + "\n");
console.log(`Signed ${channel} catalog with ${releases.length} approved release(s).`);
