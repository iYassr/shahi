import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectRelease, sha256, verifyCatalog, type Catalog, type Release } from "./catalog";
import { stage } from "./stage";
import { atomicJson, installation } from "./storage";
import { beginTransaction, finishTransaction, type Runner } from "./transaction";
import { verifyPublished } from "./published";

const keys = generateKeyPairSync("ed25519");
const trusted = { test: keys.publicKey.export({ type: "spki", format: "pem" }).toString() };
const release: Release = { version: "0.3.0", buildId: "build-1", commit: "a".repeat(40), artifact: { url: "https://github.com/iYassr/shahi/releases/download/v0.3.0/shahi-service.tar.gz", sha256: "0".repeat(64), bytes: 1 }, platforms: ["linux-x64"], bun: "1.3.13", api: { min: 5, max: 5 }, transport: 2, control: 1, manager: 1, dataSchema: 1, herdr: [{ version: "0.9.0", protocol: 22 }] };
const catalog: Catalog = { schema: 1, sequence: 10, channel: "stable", publishedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 86400_000).toISOString(), releases: [release] };
function signed(value: unknown) { const bytes = Buffer.from(JSON.stringify(value)); return JSON.stringify({ keyId: "test", payload: bytes.toString("base64"), signature: sign(null, bytes, keys.privateKey).toString("base64") }); }
const machine = { platform: "linux-x64", bun: "1.3.13", herdr: { version: "0.9.0", protocol: 22 } };
const roots: string[] = [];
function scratch() { const root = mkdtempSync(join(tmpdir(), "shahi-upgrade-")); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("approved releases", () => {
  test("promotion rejects altered assets and unapproved builds claiming the same commit", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const published = { ...release, artifact: { ...release.artifact, bytes: bytes.length, sha256: sha256(bytes) } };
    const stable = signed({ ...catalog, releases: [published] }), beta = signed({ ...catalog, channel: "beta" });
    expect(verifyPublished(published, release, bytes, stable, beta, trusted)).toEqual(published);
    expect(() => verifyPublished(published, release, new Uint8Array([3, 2, 1]), stable, beta, trusted)).toThrow("changed");
    const unapproved = { ...published, buildId: "forged-but-same-commit" };
    expect(() => verifyPublished(unapproved, release, bytes, stable, beta, trusted)).toThrow("no matching signed approval");
  });
  test("accepts a trusted, current, compatible catalog", () => {
    const c = verifyCatalog(signed(catalog), "stable", 10, trusted);
    expect(selectRelease(c, machine).release?.buildId).toBe("build-1");
  });
  test("rejects altered bytes and an untrusted signer", () => {
    const envelope = JSON.parse(signed(catalog)); envelope.payload = Buffer.from(JSON.stringify({ ...catalog, sequence: 11 })).toString("base64");
    expect(() => verifyCatalog(JSON.stringify(envelope), "stable", 0, trusted)).toThrow("signature");
    expect(() => verifyCatalog(signed(catalog), "stable")).toThrow("signature");
  });
  test("rejects replay, expired catalog, wrong channel and unsafe protocols", () => {
    expect(() => verifyCatalog(signed(catalog), "stable", 11, trusted)).toThrow();
    expect(() => verifyCatalog(signed({ ...catalog, expiresAt: "2020-01-01" }), "stable", 0, trusted)).toThrow();
    expect(() => verifyCatalog(signed(catalog), "beta", 0, trusted)).toThrow();
    for (const patch of [{ transport: 1 }, { api: { min: 4, max: 5 } }, { artifact: { ...release.artifact, url: "https://evil.example/service" } }]) {
      expect(() => verifyCatalog(signed({ ...catalog, releases: [{ ...release, ...patch }] }), "stable", 0, trusted)).toThrow();
    }
  });
  test("keeps a supported release when the newest needs different herdr", () => {
    const newest = { ...release, version: "0.4.0", herdr: [{ version: "0.10.0", protocol: 23 }] };
    const chosen = selectRelease({ ...catalog, releases: [newest, release] }, { ...machine, current: release });
    expect(chosen.release?.version).toBe("0.3.0"); expect(chosen.reason).toContain("herdr");
  });
  test("blocks unsupported platforms, runtimes, data migrations and downgrades", () => {
    for (const m of [{ ...machine, platform: "win32-x64" }, { ...machine, bun: "1.0.0" }, { ...machine, current: { ...release, dataSchema: 2 } }, { ...machine, current: { ...release, version: "0.4.0" } }]) expect(selectRelease(catalog, m).release).toBeNull();
  });
  test("requires overlap while supporting the current and previous safe API", () => {
    const transition = { ...release, api: { min: 5, max: 6 } };
    expect(selectRelease({ ...catalog, releases: [transition] }, { ...machine, current: release }).release).toBeTruthy();
    expect(selectRelease({ ...catalog, releases: [{ ...release, api: { min: 6, max: 6 } }] }, { ...machine, current: release }).release).toBeNull();
  });
});

describe("verified staging", () => {
  test("an interrupted download never changes the active release", async () => {
    const root = scratch(); atomicJson(join(root, "installation.json"), { active: release });
    await expect(stage(root, release, async () => { throw new Error("Disconnected"); })).rejects.toThrow();
    expect(installation(root)?.active.buildId).toBe(release.buildId);
    expect(existsSync(join(root, "releases", release.buildId))).toBe(false);
  });
  test("refuses altered archives before extraction", async () => {
    await expect(stage(scratch(), release, async () => new Uint8Array([1]))).rejects.toThrow("integrity");
  });
  test("stages a verified archive and rejects path traversal", async () => {
    for (const unsafe of [false, true]) {
      const bytes = new Uint8Array(await new Bun.Archive({ "service.js": "service", "manager.js": "manager", "web/index.html": '<div id="root"></div>', ...(unsafe ? { "web/../../escape": "bad" } : {}) }).bytes());
      const r = { ...release, artifact: { ...release.artifact, bytes: bytes.length, sha256: sha256(bytes) } };
      const root = scratch();
      if (unsafe) await expect(stage(root, r, async () => bytes)).rejects.toThrow("Unsafe");
      else { const dir = await stage(root, r, async () => bytes); expect(readFileSync(join(dir, "service.js"), "utf8")).toBe("service"); }
    }
  });
});

describe("restart and recovery", () => {
  const target = { ...release, version: "0.3.1", buildId: "build-2" };
  function setup(failed: boolean) {
    const root = scratch(); atomicJson(join(root, "installation.json"), { active: release, channel: "stable", sequence: { stable: 10 } });
    const activations: string[] = [], phases: string[] = [];
    const runner: Runner = { async activate(r) { activations.push(r.buildId); }, async ready(r, serverId) { expect(serverId).toBe("paired-computer"); return !failed || r.buildId === release.buildId; }, phase(p) { phases.push(p); } };
    return { root, runner, activations, phases };
  }
  test("checks the running build and preserved identity before confirming", async () => {
    const s = setup(false); await beginTransaction(s.root, target, s.runner, "paired-computer");
    expect(installation(s.root)?.active.buildId).toBe(target.buildId); expect(s.phases).toEqual(["restarting", "ready"]);
    expect(existsSync(join(s.root, "transaction.json"))).toBe(false);
  });
  test("restores the prior release on failed readiness", async () => {
    const s = setup(true); await beginTransaction(s.root, target, s.runner, "paired-computer");
    expect(s.activations).toEqual([target.buildId, release.buildId]); expect(s.phases.at(-1)).toBe("rolled-back");
    expect(installation(s.root)?.active.buildId).toBe(release.buildId);
  });
  test("resumes an interrupted activation from the durable journal", async () => {
    const s = setup(true); atomicJson(join(s.root, "transaction.json"), { previous: release, target, serverId: "paired-computer" });
    atomicJson(join(s.root, "installation.json"), { ...installation(s.root), active: target });
    await finishTransaction(s.root, s.runner);
    expect(installation(s.root)?.active.buildId).toBe(release.buildId); expect(s.phases.at(-1)).toBe("rolled-back");
  });
  test("refuses rollback across an untested data format", async () => {
    const s = setup(false); await expect(beginTransaction(s.root, { ...target, dataSchema: 2 }, s.runner)).rejects.toThrow("rollback");
    expect(s.activations).toEqual([]);
  });
});

test("release requirements match the implemented and tested adapter contracts", async () => {
  const { default: definition } = await import("./release.json");
  const { HERDR_SUPPORT } = await import("../../server/lib/backend");
  const { API_SUPPORT, RELAY_PROTOCOL } = await import("@shahi/shared");
  expect(definition.herdr).toEqual([...HERDR_SUPPORT]);
  expect(definition.api).toEqual({ min: API_SUPPORT.min, max: API_SUPPORT.max });
  expect(definition.transport).toBe(RELAY_PROTOCOL);
});
