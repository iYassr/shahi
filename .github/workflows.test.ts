/**
 * The workflows are where signing keys and write tokens meet code from outside
 * this repository. These pin the fixes from the pre-release review (September
 * 2026), because a workflow regresses silently: it keeps passing while it
 * hands out more than it should.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}
interface Job {
  permissions?: Record<string, string> | string;
  steps?: Step[];
  strategy?: { matrix?: { herdr?: string[]; include?: Record<string, string>[] } };
}
interface Workflow {
  permissions?: Record<string, string> | string;
  jobs: Record<string, Job>;
}

const ROOT = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const workflows = readdirSync(join(ROOT, ".github", "workflows"))
  .filter((file) => /\.ya?ml$/.test(file))
  .map((file) => ({ file, workflow: Bun.YAML.parse(read(`.github/workflows/${file}`)) as Workflow }));
const jobs = workflows.flatMap(({ file, workflow }) =>
  Object.entries(workflow.jobs).map(([id, job]) => ({ where: `${file} ${id}`, workflow, job, steps: job.steps ?? [] })),
);
const PACKAGE_RUNNER = /\b(bunx|npx|pnpx|npm exec|pnpm dlx|yarn dlx|bun x)\b/;

describe("phone updates", () => {
  const publish = jobs.find((j) => j.where === "mobile-update.yml publish")!;
  const signing = publish.steps.findIndex((s) => s.env && "SHAHI_OTA_PRIVATE_KEY" in s.env);

  test("the OTA signing key never meets an eas-cli resolved from npm at publish time", () => {
    // `bunx eas-cli@x` pins one package; its whole tree came from semver ranges.
    expect(signing).toBeGreaterThan(-1);
    for (const step of publish.steps) expect(step.run ?? "").not.toMatch(PACKAGE_RUNNER);
    const locked = publish.steps.findIndex((s) =>
      /cp \.github\/eas\/package\.json \.github\/eas\/bun\.lock "\$RUNNER_TEMP\/eas\/"[\s\S]*bun install --frozen-lockfile/.test(s.run ?? ""),
    );
    expect(locked).toBeGreaterThan(-1);
    expect(locked).toBeLessThan(signing);
    expect(publish.steps[signing]!.run).toContain('"$RUNNER_TEMP/eas/node_modules/.bin/eas" update');
    // What eas-cli spawns (the Metro build) has no reason to inherit the key.
    expect(publish.steps[signing]!.run).toMatch(/> "\$RUNNER_TEMP\/shahi-ota-key\.pem"[\s\S]*unset SHAHI_OTA_PRIVATE_KEY[\s\S]*\.bin\/eas" update/);
  });

  test("the locked eas-cli is exact, and every package in its tree carries an integrity hash", () => {
    const manifest = JSON.parse(read(".github/eas/package.json"));
    const version: string = manifest.dependencies["eas-cli"];
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    const lock = Bun.JSONC.parse(read(".github/eas/bun.lock")) as { packages: Record<string, unknown[]> };
    expect(lock.packages["eas-cli"]?.[0]).toBe(`eas-cli@${version}`);
    const unhashed = Object.entries(lock.packages).filter(([, entry]) => !/^sha512-/.test(String(entry.at(-1))));
    expect(unhashed).toEqual([]);
  });

  test("eas-cli stays out of the app's dependency tree", () => {
    // Tried during the review: in the workspace it hoisted its @expo/config 55
    // over SDK 57's, and every plugin install would download it too.
    for (const manifest of ["package.json", "mobile/package.json"]) expect(read(manifest)).not.toContain('"eas-cli"');
    expect(read("bun.lock")).not.toContain('"eas-cli@');
  });
});
