/**
 * A first install used to install nothing on any herdr the catalog did not
 * list, which is every new user from the day herdr ships a release until
 * Shahi signs one, and to refuse an old bun as "The computer's installer needs
 * an update". Neither message named a version or a fix (pre-public-release
 * review).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { firstRelease } from "./bootstrap";
import type { Catalog, Release } from "./catalog";
import { bunRequirement } from "./requirements";

const release = (version: string, patch: Partial<Release> = {}): Release => ({
  version, buildId: `build-${version}`, commit: "a".repeat(40),
  artifact: { url: `https://github.com/iYassr/shahi/releases/download/v${version}/shahi-service.tar.gz`, sha256: "0".repeat(64), bytes: 1 },
  platforms: ["darwin-arm64", "linux-x64"], bun: "1.3.13", api: { min: 5, max: 5 }, transport: 2, control: 1, manager: 1, dataSchema: 1,
  herdr: [{ version: "0.9.0", protocol: 22 }, { version: "0.9.1", protocol: 22 }], ...patch,
});
const catalog: Catalog = {
  schema: 1, channel: "stable", sequence: 1, publishedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400_000).toISOString(),
  releases: [release("0.3.6"), release("0.3.5", { herdr: [{ version: "0.9.0", protocol: 22 }] })],
};
const machine = { platform: "darwin-arm64", bun: "1.3.13", herdr: { version: "0.9.1", protocol: 22 } };

describe("the release a first install runs", () => {
  test("a herdr newer than every approved one still gets Shahi, in recovery, with both versions named", () => {
    const chosen = firstRelease(catalog, { ...machine, herdr: { version: "0.9.2", protocol: 22 } });
    expect(chosen.release.version).toBe("0.3.6");
    expect(chosen.notice).toContain("this computer runs herdr 0.9.2 (protocol 22)");
    expect(chosen.notice).toContain("approved for herdr 0.9.0 (protocol 22), 0.9.1 (protocol 22)");
    expect(chosen.notice).toContain("pair now");
  });

  test("an approved herdr gets the newest release that supports it, with nothing to explain", () => {
    expect(firstRelease(catalog, machine)).toEqual({ release: catalog.releases[0]! });
    expect(firstRelease({ ...catalog, releases: [release("0.3.7", { herdr: [{ version: "0.9.2", protocol: 22 }] }), ...catalog.releases] }, machine))
      .toEqual({ release: catalog.releases[0]! });
  });

  test("herdr not running installs the newest release, as it always has", () => {
    expect(firstRelease(catalog, { ...machine, herdr: null })).toEqual({ release: catalog.releases[0]! });
  });

  test("an old bun is refused naming bun, both versions and the fix", () => {
    expect(() => firstRelease(catalog, { ...machine, bun: "1.2.21" })).toThrow(
      "Shahi 0.3.6 needs bun 1.3.13 or newer, and this computer has bun 1.2.21. Upgrade bun on this computer (bun upgrade",
    );
    // Also on a herdr with no approved release: recovery does not lift it.
    expect(() => firstRelease(catalog, { ...machine, bun: "1.2.21", herdr: { version: "0.9.2", protocol: 22 } })).toThrow("needs bun 1.3.13");
  });

  test("an unsupported platform is refused naming the platforms", () => {
    expect(() => firstRelease(catalog, { ...machine, platform: "linux-arm64" })).toThrow("Shahi 0.3.6 runs on darwin-arm64, linux-x64, and this computer is linux-arm64.");
  });
});

describe("the first build step of herdr plugin install", () => {
  test("refuses an old bun by name, with its path and the fix", () => {
    const problem = bunRequirement("1.3.12", "1.3.13", "/home/me/.bun/bin/bun");
    expect(problem).toContain("Shahi needs bun 1.3.13 or newer, and this install is running bun 1.3.12 (/home/me/.bun/bin/bun)");
    expect(problem).toContain("bun upgrade");
    expect(bunRequirement("1.3.13", "1.3.13", "bun")).toBeNull();
    expect(bunRequirement("1.4.0", "1.3.13", "bun")).toBeNull();
  });

  test("passes on the bun CI runs, importing nothing that needs bun install", () => {
    // It runs before `bun install`, so it must start from a checkout with no
    // node_modules: nothing but release.json and version.ts.
    const run = Bun.spawnSync([process.execPath, join(import.meta.dir, "requirements.ts")], { stdout: "pipe", stderr: "pipe" });
    expect(run.stderr.toString()).toBe("");
    expect(run.exitCode).toBe(0);
    const imports = new Bun.Transpiler({ loader: "ts" }).scanImports(readFileSync(join(import.meta.dir, "requirements.ts"), "utf8"));
    expect(imports.map(i => i.path).sort()).toEqual(["./release.json", "./version"]);
    expect(new Bun.Transpiler({ loader: "ts" }).scanImports(readFileSync(join(import.meta.dir, "version.ts"), "utf8"))).toEqual([]);
  });
});
