const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const PROJECT_ID = "fa81100f-5f3c-4c44-898b-4ecd740a84e9";
const root = process.env.RUNNER_TEMP ?? os.tmpdir();
const stateFile = path.join(os.homedir(), ".expo", "state.json");
const secretFile = path.join(root, "shahi-sentry-variable.json");
const buildFile = path.join(root, "shahi-ios-build.json");
const sessionOwnerFile = path.join(root, "shahi-expo-session-owned");
const easRoot = path.join(root, "eas", "node_modules", "eas-cli", "build");
const easBin = path.join(root, "eas", "node_modules", ".bin", "eas");

async function client() {
  const SessionManager = require(path.join(easRoot, "user/SessionManager")).default;
  const { createGraphqlClient } = require(path.join(easRoot, "commandUtils/context/contextUtils/createGraphqlClient"));
  const { authenticationInfo } = await new SessionManager({ setActor() {} }).ensureLoggedInAsync({ nonInteractive: true });
  return createGraphqlClient(authenticationInfo);
}
function validateCiRun(run, sha) {
  if (run.head_sha !== sha || run.path !== ".github/workflows/ci.yml" || run.event !== "workflow_dispatch" || run.head_branch !== "master") throw new Error("CI must be the manual CI workflow on this exact master commit.");
  if (run.status === "completed" && run.conclusion !== "success") throw new Error("The exact-commit CI run did not pass.");
  return run.status === "completed" && run.conclusion === "success";
}
async function ciRun() {
  if (!/^\d+$/.test(process.env.CI_RUN_ID ?? "")) throw new Error("A manual CI run ID is required.");
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.CI_RUN_ID}`, {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!response.ok) throw new Error("Could not verify the CI run.");
  const run = await response.json();
  return validateCiRun(run, process.env.GITHUB_SHA);
}
function eas(args, json = false) {
  const result = spawnSync(easBin, args, { cwd: path.join(process.env.GITHUB_WORKSPACE, "mobile"), encoding: "utf8", stdio: json ? ["ignore", "pipe", "inherit"] : "inherit", timeout: json ? 120_000 : 40 * 60_000 });
  if (result.status !== 0) throw new Error("The EAS release operation failed.");
  return json ? JSON.parse(result.stdout) : undefined;
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function prepare() {
  await ciRun();
  if (!process.env.EXPO_EAS_SESSION || !process.env.SENTRY_AUTH_TOKEN) throw new Error("Protected release credentials are missing.");
  const config = JSON.parse(fs.readFileSync("mobile/app.json", "utf8"));
  if (config.expo.extra.eas.projectId !== PROJECT_ID || config.expo.ios.bundleIdentifier !== "app.shahi.mobile") throw new Error("Native app identity mismatch.");
  prepareExpoSession();
  const graphqlClient = await client();
  const { EnvironmentVariablesQuery } = require(path.join(easRoot, "graphql/queries/EnvironmentVariablesQuery"));
  const { EnvironmentVariableMutation } = require(path.join(easRoot, "graphql/mutations/EnvironmentVariableMutation"));
  const existing = await EnvironmentVariablesQuery.byAppIdAsync(graphqlClient, { appId: PROJECT_ID, filterNames: ["SENTRY_AUTH_TOKEN"], environment: "production", includeFileContent: false });
  if (existing.length) throw new Error("A production Sentry variable already exists; refusing to replace it.");
  const variable = await EnvironmentVariableMutation.createForAppAsync(graphqlClient, {
    name: "SENTRY_AUTH_TOKEN", value: process.env.SENTRY_AUTH_TOKEN,
    environments: ["production"], visibility: "SECRET", type: "STRING",
  }, PROJECT_ID);
  delete process.env.SENTRY_AUTH_TOKEN;
  fs.writeFileSync(secretFile, JSON.stringify({ id: variable.id }), { mode: 0o600, flag: "wx" });
  console.log("Exact-commit CI identity verified; temporary protected symbol-upload credential prepared.");
}

async function upload() {
  const build = JSON.parse(fs.readFileSync(buildFile, "utf8"))[0];
  if (!build?.id || build.platform !== "IOS" || build.gitCommitHash !== process.env.GITHUB_SHA) throw new Error("The native build does not match the tested source.");
  const deadline = Date.now() + 95 * 60_000;
  let ready = false;
  while (Date.now() < deadline) {
    const current = eas(["build:view", build.id, "--json"], true);
    if (["ERRORED", "CANCELED"].includes(current.status)) throw new Error("The production native build failed.");
    if (current.status === "FINISHED") { ready = true; break; }
    await pause(30_000);
  }
  if (!ready) throw new Error("The native archive did not finish within the release window.");
  const ciDeadline = Date.now() + 30 * 60_000;
  while (!(await ciRun())) {
    if (Date.now() >= ciDeadline) throw new Error("The native archive is ready but exact-commit CI is still pending.");
    await pause(20_000);
  }
  console.log(`Production iPhone build ${build.appBuildVersion ?? ""} passed archive and exact-commit CI; uploading for review.`);
  eas(["submit", "--platform", "ios", "--profile", "production", "--id", build.id, "--non-interactive", "--wait"]);
}

async function cleanup() {
  try {
    if (fs.existsSync(secretFile)) {
      const { id } = JSON.parse(fs.readFileSync(secretFile, "utf8"));
      const { EnvironmentVariableMutation } = require(path.join(easRoot, "graphql/mutations/EnvironmentVariableMutation"));
      await EnvironmentVariableMutation.deleteAsync(await client(), id);
      fs.unlinkSync(secretFile);
      console.log("Removed this run's temporary Sentry credential.");
    }
  } finally {
    cleanupExpoSession();
    fs.rmSync(buildFile, { force: true });
  }
}
function prepareExpoSession(session = process.env.EXPO_EAS_SESSION, target = stateFile, owner = sessionOwnerFile) {
  if (!session) throw new Error("Protected Expo authentication is missing.");
  if (fs.existsSync(target) || fs.existsSync(owner)) throw new Error("The release runner already has an Expo session; refusing to replace it.");
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, JSON.stringify({ auth: { sessionSecret: session } }), { mode: 0o600, flag: "wx" });
  fs.writeFileSync(owner, "owned", { mode: 0o600, flag: "wx" });
  delete process.env.EXPO_EAS_SESSION;
}
function cleanupExpoSession(target = stateFile, owner = sessionOwnerFile) {
  if (fs.existsSync(owner)) {
    fs.rmSync(target, { force: true }); fs.rmSync(owner, { force: true });
  }
}
const actions = { prepare, upload, cleanup, login: prepareExpoSession, logout: cleanupExpoSession };
module.exports = { validateCiRun, prepareExpoSession, cleanupExpoSession };
if (require.main === module) {
  if (!process.env.RUNNER_TEMP) throw new Error("This script runs only in the protected release runner.");
  if (!actions[process.argv[2]]) throw new Error("Unknown release operation.");
  Promise.resolve().then(() => actions[process.argv[2]]()).catch(() => { console.error("Native release step failed. Protected credentials were not printed; inspect the operation's preceding status."); process.exitCode = 1; });
}
