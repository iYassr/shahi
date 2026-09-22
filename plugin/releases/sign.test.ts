/**
 * The signer, found wanting by the pre-public-release review in three ways:
 *
 * - A catalog lapses 120 days after signing, and the signer refused an
 *   expired previous catalog, so a channel that lapsed could never be signed
 *   again, and renewing one needed a new package version.
 * - Every release was carried forward forever and a computer refuses more
 *   than 50, so the 51st signing would have failed, security fix or not.
 * - Nothing could withdraw a release once approved.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_RELEASES, selectRelease, sha256, verifyCatalog, type Catalog, type Machine, type Release } from "./catalog";
import { verifyPublished } from "./published";
import { CATALOG_LIFETIME_MS, daysLeft, nextCatalog, previousCatalog, signCatalog } from "./sign";

const keys = generateKeyPairSync("ed25519");
const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const trusted = { "shahi-2026": publicKey };
const DAY = 86400_000;

const release = (version: string, patch: Partial<Release> = {}): Release => ({
  version, buildId: `build-${version}`, commit: "a".repeat(40),
  artifact: { url: `https://github.com/iYassr/shahi/releases/download/v${version}/shahi-service.tar.gz`, sha256: "0".repeat(64), bytes: 1 },
  platforms: ["darwin-arm64", "linux-x64"], bun: "1.3.13", api: { min: 5, max: 5 }, transport: 2, control: 1, manager: 1, dataSchema: 1,
  herdr: [{ version: "0.9.0", protocol: 22 }, { version: "0.9.1", protocol: 22 }], ...patch,
});
const catalogOf = (releases: Release[], publishedAt = Date.now() - 1000, patch: Partial<Catalog> = {}): Catalog => ({
  schema: 1, channel: "stable", sequence: publishedAt, publishedAt: new Date(publishedAt).toISOString(),
  expiresAt: new Date(publishedAt + CATALOG_LIFETIME_MS).toISOString(), releases, ...patch,
});
/** Signed 200 days ago, so it lapsed 80 days ago. */
const lapsed = (releases: Release[], channel: "stable" | "beta" = "stable") => signCatalog(catalogOf(releases, Date.now() - 200 * DAY, { channel }), privateKey);

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("a channel whose catalog lapsed", () => {
  const history = [release("0.3.6"), release("0.3.5", { bun: "1.3.0" })];

  test("computers refuse it, naming the date and who has to act", () => {
    expect(() => verifyCatalog(lapsed(history), "stable", 0, trusted)).toThrow(/^Shahi's signed release catalog expired on \d{4}-\d\d-\d\d and has to be renewed by Shahi\./);
  });

  test("is renewed without a new package: the same releases, a later expiry, a higher sequence", () => {
    const now = Date.now();
    const previous = previousCatalog(lapsed(history), "stable", trusted);
    const renewed = nextCatalog("stable", previous, null, { now });
    expect(renewed.releases).toEqual(history);
    expect(renewed.sequence).toBeGreaterThan(previous.sequence);
    expect(renewed.expiresAt).toBe(new Date(now + CATALOG_LIFETIME_MS).toISOString());
    expect(verifyCatalog(signCatalog(renewed, privateKey), "stable", previous.sequence, trusted).releases).toEqual(history);
  });

  test("can take a new release too", () => {
    const next = nextCatalog("stable", previousCatalog(lapsed(history), "stable", trusted), release("0.3.7"));
    expect(next.releases.map(r => r.version)).toEqual(["0.3.7", "0.3.5"]);
  });

  test("is still refused from another signer, for another channel, or as a replay", () => {
    const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(() => previousCatalog(lapsed(history), "stable", { "shahi-2026": other })).toThrow("signature");
    expect(() => previousCatalog(lapsed(history, "beta"), "stable", trusted)).toThrow("invalid");
    const previous = previousCatalog(lapsed(history), "stable", trusted);
    expect(() => verifyCatalog(signCatalog(previous, privateKey), "stable", previous.sequence + 1, trusted)).toThrow("older than one this computer already accepted");
  });

  test("still proves a package was approved, so it can be promoted", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const published = release("0.3.6", { artifact: { ...release("0.3.6").artifact, bytes: bytes.length, sha256: sha256(bytes) } });
    // Builds are not byte-reproducible, so a rebuild at the same commit differs.
    const rebuilt = { ...published, artifact: { ...published.artifact, sha256: "f".repeat(64) } };
    expect(verifyPublished(published, rebuilt, bytes, lapsed([published]), lapsed([published], "beta"), trusted)).toEqual(published);
  });

  test("renewal needs the channel's current catalog", () => {
    expect(() => nextCatalog("stable", null, null)).toThrow("Renewal needs the channel's current catalog.");
  });

  test("days left counts down to expiry and below zero after", () => {
    const now = Date.now();
    expect(daysLeft(catalogOf(history, now), now)).toBe(120);
    expect(Math.round(daysLeft(previousCatalog(lapsed(history), "stable", trusted), now))).toBe(-80);
  });
});

describe("a channel that has shipped many releases", () => {
  test("the 51st release still signs, because superseded releases are dropped", () => {
    const fifty = Array.from({ length: MAX_RELEASES }, (_, i) => release(`0.3.${MAX_RELEASES - 1 - i}`));
    const previous = verifyCatalog(signCatalog(catalogOf(fifty), privateKey), "stable", 0, trusted);
    const next = nextCatalog("stable", previous, release(`0.3.${MAX_RELEASES}`));
    expect(next.releases.map(r => r.version)).toEqual([`0.3.${MAX_RELEASES}`]);
    expect(verifyCatalog(signCatalog(next, privateKey), "stable", previous.sequence, trusted).releases).toHaveLength(1);
  });

  test("a release that still serves a herdr, bun, platform, data format or API no newer one covers is kept", () => {
    const newest = release("0.4.0", { herdr: [{ version: "0.9.1", protocol: 22 }] });
    const kept = [
      release("0.3.9", { herdr: [{ version: "0.9.0", protocol: 22 }] }),
      release("0.3.8", { bun: "1.3.0", herdr: [{ version: "0.9.1", protocol: 22 }] }),
      release("0.3.7", { platforms: ["linux-arm64"], herdr: [{ version: "0.9.1", protocol: 22 }] }),
      release("0.3.6", { dataSchema: 2, herdr: [{ version: "0.9.1", protocol: 22 }] }),
    ];
    expect(nextCatalog("stable", catalogOf(kept), newest).releases).toEqual([newest, ...kept]);
    // A newer release that drops the oldest API generation leaves the one that has it.
    const older = release("0.3.9", { api: { min: 5, max: 5 } }), successor = release("0.4.0", { api: { min: 6, max: 6 } });
    expect(nextCatalog("stable", catalogOf([older]), successor).releases).toEqual([successor, older]);
  });

  test("dropping superseded releases never changes which release a computer selects", () => {
    const full = [
      release("0.4.0", { herdr: [{ version: "0.9.1", protocol: 22 }, { version: "0.9.2", protocol: 22 }] }),
      release("0.3.9"),
      release("0.3.8", { herdr: [{ version: "0.9.1", protocol: 22 }] }),
      release("0.3.7", { bun: "1.3.0" }),
      release("0.3.6", { bun: "1.3.0", herdr: [{ version: "0.9.0", protocol: 22 }] }),
      release("0.3.5", { platforms: ["linux-arm64", "linux-x64"] }),
      release("0.3.4", { dataSchema: 2 }),
      release("0.3.3"),
    ];
    const pruned = nextCatalog("stable", catalogOf(full.slice(1)), full[0]!).releases;
    expect(pruned.length).toBeLessThan(full.length);
    const machines: Machine[] = [];
    for (const platform of ["darwin-arm64", "linux-x64", "linux-arm64"]) for (const bun of ["1.3.0", "1.3.13"])
      for (const herdr of [null, ...["0.9.0", "0.9.1", "0.9.2", "0.9.3"].map(version => ({ version, protocol: 22 }))])
        for (const current of [undefined, ...full]) machines.push({ platform, bun, herdr, ...(current ? { current } : {}) });
    for (const m of machines) expect(selectRelease(catalogOf(pruned), m)).toEqual(selectRelease(catalogOf(full), m));
  });

  test("an unsafe release is withdrawn by name", () => {
    const history = [release("0.3.6"), release("0.3.5", { bun: "1.3.0" })];
    expect(nextCatalog("stable", catalogOf(history), null, { retire: ["0.3.5"] }).releases).toEqual([history[0]!]);
    expect(nextCatalog("stable", catalogOf(history), release("0.3.7", { bun: "1.3.14" }), { retire: ["0.3.6"] }).releases.map(r => r.version)).toEqual(["0.3.7", "0.3.5"]);
  });

  test("withdrawing a version the channel does not have, the one being approved, or everything is refused", () => {
    const history = [release("0.3.6")];
    expect(() => nextCatalog("stable", catalogOf(history), null, { retire: ["0.2.0"] })).toThrow("Cannot retire 0.2.0: not in the stable catalog.");
    expect(() => nextCatalog("stable", catalogOf(history), release("0.3.7"), { retire: ["0.3.7"] })).toThrow("cannot be approved and retired at once");
    expect(() => nextCatalog("stable", catalogOf(history), null, { retire: ["0.3.6"] })).toThrow("at least one approved release");
  });

  test("approving a release that a newer one supersedes fails instead of signing a catalog without it", () => {
    expect(() => nextCatalog("stable", catalogOf([release("0.3.7")]), release("0.3.6"))).toThrow("Shahi 0.3.6 is superseded by a newer release in the stable catalog");
  });

  test("more than 50 selectable releases asks for a retirement, and a computer names the cap", () => {
    const distinct = Array.from({ length: MAX_RELEASES }, (_, i) => release(`0.3.${i}`, { herdr: [{ version: `0.9.${i}`, protocol: 22 }] }));
    expect(() => nextCatalog("stable", catalogOf(distinct), release("0.4.0", { herdr: [{ version: "0.10.0", protocol: 22 }] })))
      .toThrow(`${MAX_RELEASES + 1} releases are still selectable, more than the ${MAX_RELEASES} a computer accepts. Retire the oldest explicitly.`);
    const tooMany = signCatalog(catalogOf([...distinct, release("0.4.0", { herdr: [{ version: "0.10.0", protocol: 22 }] })]), privateKey);
    expect(() => verifyCatalog(tooMany, "stable", 0, trusted)).toThrow(`Release catalog lists ${MAX_RELEASES + 1} releases, more than the ${MAX_RELEASES} a computer accepts.`);
  });

  test("a beta build still cannot enter Stable, and an approved version cannot change", () => {
    expect(() => nextCatalog("stable", catalogOf([release("0.3.6")]), release("0.3.7-beta.1"))).toThrow("A beta build cannot enter Stable.");
    expect(() => nextCatalog("stable", catalogOf([release("0.3.6")]), release("0.3.6", { commit: "b".repeat(40) }))).toThrow("Released versions are immutable.");
  });
});

describe("sign.ts, run the way the workflows run it", () => {
  // The real CLI, with the trusted key replaced by this test's key for the
  // run only (as manager-smoke.ts does for the manager).
  function cli() {
    const dir = mkdtempSync(join(tmpdir(), "shahi-sign-")); roots.push(dir);
    const preload = join(dir, "test-key.ts");
    writeFileSync(preload, `Bun.plugin({ name: "test-release-key", setup(build) {
      build.onLoad({ filter: /releases[\\\\/]trust\\.ts$/ }, () => ({ contents: ${JSON.stringify(`export const RELEASE_KEYS = ${JSON.stringify(trusted)};`)}, loader: "ts" }));
    } });\n`);
    writeFileSync(join(dir, "key.pem"), privateKey, { mode: 0o600 });
    const sign = (...args: string[]) => {
      const run = Bun.spawnSync([process.execPath, "--preload", preload, join(import.meta.dir, "sign.ts"), ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      return { code: run.exitCode, out: run.stdout.toString().trim(), err: run.stderr.toString() };
    };
    const read = (file: string) => verifyCatalog(readFileSync(join(dir, file), "utf8"), "stable", 0, trusted);
    return { dir, sign, read };
  }

  test("approve after a lapse (release.yml), then check and renew (catalog-expiry.yml)", () => {
    const { dir, sign, read } = cli();
    writeFileSync(join(dir, "previous.json"), lapsed([release("0.3.6"), release("0.3.5", { bun: "1.3.0" })]));
    writeFileSync(join(dir, "release.json"), JSON.stringify(release("0.3.7")));

    expect(sign("due", "stable", "previous.json", "30").out).toBe("true");
    const approved = sign("stable", "release.json", "key.pem", "catalog.json", "previous.json");
    expect(approved.err).toBe("");
    expect(read("catalog.json").releases.map(r => r.version)).toEqual(["0.3.7", "0.3.5"]);
    expect(sign("due", "stable", "catalog.json", "30").out).toBe("false");

    const renewed = sign("renew", "stable", "key.pem", "renewed.json", "catalog.json", "--retire", "0.3.5");
    expect(renewed.err).toBe("");
    expect(read("renewed.json").releases.map(r => r.version)).toEqual(["0.3.7"]);
    expect(read("renewed.json").sequence).toBeGreaterThan(read("catalog.json").sequence);
  });

  test("a renewal with no previous catalog signs nothing", () => {
    const { dir, sign } = cli();
    const run = sign("renew", "stable", "key.pem", "renewed.json");
    expect(run.code).not.toBe(0);
    expect(run.err).toContain("Usage:");
    expect(() => readFileSync(join(dir, "renewed.json"))).toThrow();
  });
});
