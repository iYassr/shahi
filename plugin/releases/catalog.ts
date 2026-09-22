import { createHash, verify } from "node:crypto";
import { API_SUPPORT, type ReleaseChannel } from "@shahi/shared";
import { RELEASE_KEYS } from "./trust";
import { compareVersion } from "./version";
export { compareVersion };

export interface Release {
  version: string;
  buildId: string;
  commit: string;
  artifact: { url: string; sha256: string; bytes: number };
  platforms: string[];
  bun: string;
  api: { min: number; max: number };
  transport: 2;
  control: 1;
  manager: 1;
  dataSchema: number;
  herdr: { version: string; protocol: number }[];
}
export interface Catalog {
  schema: 1;
  channel: ReleaseChannel;
  sequence: number;
  publishedAt: string;
  expiresAt: string;
  releases: Release[];
}
export interface SignedCatalog { keyId: string; payload: string; signature: string }
export const CATALOG_URL = (channel: ReleaseChannel) => `https://github.com/iYassr/shahi/releases/download/shahi-${channel}/catalog.json`;
export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const plain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const integer = (v: unknown, min = 0): v is number => Number.isSafeInteger(v) && (v as number) >= min;
const version = (v: unknown): v is string => typeof v === "string" && /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(v);
const range = (v: unknown): v is { min: number; max: number } => plain(v) && integer(v.min, API_SUPPORT.securityFloor) && integer(v.max, v.min) && v.max - v.min < API_SUPPORT.generations;

export function validateRelease(v: unknown): asserts v is Release {
  if (!plain(v) || !version(v.version) || typeof v.buildId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(v.buildId) ||
      typeof v.commit !== "string" || !/^[a-f0-9]{40}$/.test(v.commit) || !plain(v.artifact) ||
      typeof v.artifact.url !== "string" || !new RegExp(`^https://github\\.com/iYassr/shahi/releases/download/v${v.version.replaceAll(".", "\\.")}/shahi-service\\.tar\\.gz$`).test(v.artifact.url) ||
      typeof v.artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(v.artifact.sha256) || !integer(v.artifact.bytes, 1) || v.artifact.bytes > 64 * 1024 * 1024 ||
      !Array.isArray(v.platforms) || !v.platforms.length || !v.platforms.every(p => ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"].includes(p)) ||
      !version(v.bun) || !range(v.api) || v.transport !== 2 || v.control !== 1 || v.manager !== 1 || !integer(v.dataSchema, 1) ||
      !Array.isArray(v.herdr) || !v.herdr.length || !v.herdr.every(h => plain(h) && version(h.version) && integer(h.protocol, 22))) {
    throw new Error("Invalid or unsafe release manifest.");
  }
}

/** Every verifier refuses more, so the signer prunes (sign.ts) rather than ever producing a catalog that fails here. */
export const MAX_RELEASES = 50;

/**
 * `allowExpired` is for the signer alone. It carries an expired catalog's
 * history forward (signature, channel and sequence still verified): refusing
 * it meant a channel that lapsed could never be signed again without a code
 * change (pre-public-release review). A computer never passes it.
 */
export function verifyCatalog(text: string, channel: ReleaseChannel, minimumSequence = 0, keys = RELEASE_KEYS, now = Date.now(), { allowExpired = false } = {}): Catalog {
  if (Buffer.byteLength(text) > 256 * 1024) throw new Error("Release catalog is too large.");
  const envelope: unknown = JSON.parse(text);
  if (!plain(envelope) || typeof envelope.keyId !== "string" || typeof envelope.payload !== "string" || typeof envelope.signature !== "string" ||
      !Object.hasOwn(keys, envelope.keyId) || !verify(null, Buffer.from(envelope.payload, "base64"), keys[envelope.keyId]!, Buffer.from(envelope.signature, "base64"))) {
    throw new Error("Release signature could not be verified.");
  }
  const c: unknown = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
  if (!plain(c) || c.schema !== 1 || c.channel !== channel || !integer(c.sequence) ||
      typeof c.publishedAt !== "string" || typeof c.expiresAt !== "string" || !Number.isFinite(Date.parse(c.publishedAt)) ||
      !Number.isFinite(Date.parse(c.expiresAt)) || Date.parse(c.expiresAt) <= Date.parse(c.publishedAt) ||
      !Array.isArray(c.releases) || !c.releases.length) throw new Error("Release catalog is invalid.");
  // One message per cause, because each has a different owner: a replay is a
  // stale mirror or an attack, a future date is this computer's clock, expiry
  // is Shahi's renewal, and the cap is the signer's pruning. One shared
  // message ("expired, replayed, or invalid") hid all four.
  if ((c.sequence as number) < minimumSequence) throw new Error("Release catalog is older than one this computer already accepted.");
  if (Date.parse(c.publishedAt) > now + 5 * 60_000) throw new Error("Release catalog is dated in the future. Check this computer's clock.");
  if (!allowExpired && !(Date.parse(c.expiresAt) > now)) {
    throw new Error(`Shahi's signed release catalog expired on ${new Date(Date.parse(c.expiresAt)).toISOString().slice(0, 10)} and has to be renewed by Shahi. An installed release keeps running.`);
  }
  if (c.releases.length > MAX_RELEASES) throw new Error(`Release catalog lists ${c.releases.length} releases, more than the ${MAX_RELEASES} a computer accepts.`);
  for (const r of c.releases) validateRelease(r);
  if (new Set(c.releases.map(r => (r as Release).version)).size !== c.releases.length) throw new Error("Duplicate release version.");
  if (new Set(c.releases.map(r => (r as Release).buildId)).size !== c.releases.length) throw new Error("Duplicate release identifier.");
  if (channel === "stable" && c.releases.some(r => (r as Release).version.includes("-"))) throw new Error("Stable cannot include prereleases.");
  return c as unknown as Catalog;
}

export interface Machine { platform: string; bun: string; herdr: { version: string; protocol: number } | null; current?: Release }
export const supportsHerdr = (r: Release, herdr: { version: string; protocol: number }) =>
  r.herdr.some(h => h.version === herdr.version && h.protocol === herdr.protocol);
export const herdrProfiles = (r: Release) => r.herdr.map(h => `${h.version} (protocol ${h.protocol})`).join(", ");
/**
 * Each reason names both sides and the fix, because it is the one line a
 * person sees: in the pair popup on a first install, and as the update status
 * in the app. The bun reason used to say "The computer's installer needs an
 * update", naming neither bun nor a version (pre-public-release review).
 */
export function incompatibility(r: Release, m: Machine): string | null {
  if (!r.platforms.includes(m.platform)) return `Shahi ${r.version} runs on ${r.platforms.join(", ")}, and this computer is ${m.platform}.`;
  if (compareVersion(m.bun, r.bun) < 0) return `Shahi ${r.version} needs bun ${r.bun} or newer, and this computer has bun ${m.bun}. Upgrade bun on this computer (bun upgrade, or brew upgrade bun if Homebrew installed it).`;
  if (m.herdr && !supportsHerdr(r, m.herdr)) return `Shahi ${r.version} is approved for herdr ${herdrProfiles(r)}, and this computer runs herdr ${m.herdr.version} (protocol ${m.herdr.protocol}).`;
  // A rollback must not reinterpret a migrated database. Ship migrations only
  // after adding an explicit tested upgrade path, never by changing this test.
  if (m.current && r.dataSchema !== m.current.dataSchema) return "This release needs a separately approved data upgrade.";
  if (m.current && r.api.min > m.current.api.max) return "Install the intermediate supported Shahi release first.";
  return null;
}
export function selectRelease(c: Catalog, m: Machine): { release: Release | null; reason?: string } {
  const ordered = [...c.releases].sort((a, b) => compareVersion(b.version, a.version));
  const release = ordered.find(r => !incompatibility(r, m) && (!m.current || compareVersion(r.version, m.current.version) >= 0)) ?? null;
  const newest = ordered[0]!;
  const reason = release?.version === newest.version ? undefined : incompatibility(newest, m) ?? "This computer already runs a newer supported release.";
  return { release, ...(reason ? { reason } : {}) };
}

/** Bound the body while streaming, including responses without Content-Length. */
export async function download(url: string, limit: number): Promise<Uint8Array> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000), headers: { "user-agent": "Shahi-Updater/1" } });
  if (!res.ok || !res.body) throw new Error(`Approved release download failed (${res.status}).`);
  const reader = res.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length;
      if (size > limit) throw new Error("Approved release download exceeded its size limit."); chunks.push(value); }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}
