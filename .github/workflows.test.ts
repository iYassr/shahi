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
const steps = jobs.flatMap(({ where, steps }) => steps.map((step, i) => ({ where: `${where} step ${i + 1}`, step })));
const runsHerdr = (step: Step) => /herdr --version|start-herdr\.sh|herdr-live\.test\.ts/.test(step.run ?? "");
const installsHerdr = (step: Step) => /install-herdr\.sh/.test(step.run ?? "");
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

describe("tokens beside third-party code", () => {
  test("no checkout leaves the job token in .git/config", () => {
    const checkouts = steps.filter(({ step }) => step.uses?.startsWith("actions/checkout@"));
    expect(checkouts.length).toBeGreaterThan(0);
    const persisted = checkouts.filter(({ step }) => step.with?.["persist-credentials"] !== false).map(({ where }) => where);
    expect(persisted).toEqual([]);
  });

  test("a job that runs a downloaded herdr can write nothing", () => {
    const herdrJobs = jobs.filter(({ steps }) => steps.some(runsHerdr));
    expect(herdrJobs.map((j) => j.where).sort()).toEqual(["ci.yml herdr", "herdr-preview.yml preview"]);
    for (const { where, workflow, job } of herdrJobs) {
      const permissions = job.permissions ?? workflow.permissions;
      expect({ where, permissions }).toEqual({ where, permissions: { contents: "read" } });
    }
    // The installer needs a token to read the release; herdr itself gets none.
    const exposed = steps.filter(({ step }) => runsHerdr(step) && /GH_TOKEN|GITHUB_TOKEN|github\.token/.test(JSON.stringify(step.env ?? {})));
    expect(exposed.map(({ where }) => where)).toEqual([]);
  });

  test("the preview failure is filed by a job that checks out and runs nothing", () => {
    const writers = jobs.filter(({ where }) => where.startsWith("herdr-preview.yml")).filter(({ job }) => typeof job.permissions === "object" && Object.values(job.permissions).includes("write"));
    expect(writers.map(({ where }) => where)).toEqual(["herdr-preview.yml report"]);
    expect(writers[0]!.job.permissions).toEqual({ issues: "write" });
    expect(writers[0]!.steps.every((s) => !s.uses && !runsHerdr(s) && !installsHerdr(s))).toBe(true);
  });
});

describe("herdr on the runners", () => {
  test("herdr arrives only through the digest-checking installer", () => {
    for (const { where, step } of steps) {
      const run = step.run ?? "";
      expect({ where, pipedToShell: /\|\s*(sudo\s+)?(ba|z)?sh\b/.test(run) }).toEqual({ where, pipedToShell: false });
      expect({ where, directDownload: /herdr\/releases\/download/.test(run) }).toEqual({ where, directDownload: false });
    }
    for (const { where, steps } of jobs.filter(({ steps }) => steps.some(runsHerdr))) {
      const installed = steps.findIndex(installsHerdr);
      expect({ where, installed: installed > -1 && installed < steps.findIndex(runsHerdr) }).toEqual({ where, installed: true });
    }
  });

  test("every pinned herdr tag is also a pinned binary", () => {
    const herdr = jobs.find((j) => j.where === "ci.yml herdr")!;
    const matrix = herdr.job.strategy!.matrix!;
    const tags = matrix.herdr!.filter((tag) => tag !== "stable");
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      const pin = matrix.include?.find((entry) => entry.herdr === tag)?.sha256;
      expect({ tag, pin }).toEqual({ tag, pin: expect.stringMatching(/^[0-9a-f]{64}$/) });
    }
    const install = herdr.steps.find(installsHerdr)!;
    expect(install.env?.HERDR_SHA256).toBe("${{ matrix.sha256 }}");
    expect(install.run).toContain('install-herdr.sh "$HERDR_RELEASE" "$HERDR_SHA256"');
  });
});
