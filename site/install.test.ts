import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Auth, readCookie, SESSION_COOKIE } from "../server/lib/auth";
import release from "../plugin/releases/release.json";
import pin from "./herdr-pin.json";
import { HERDR_PLATFORMS, installScript } from "./install";

// The installer must never put a herdr in front of someone that no Shahi
// release is approved for (docs/releases.md).
test("the installer's herdr is one the current Shahi release is approved for", () => {
  expect(release.herdr.map((h: { version: string }) => h.version)).toContain(pin.version);
  for (const platform of HERDR_PLATFORMS) expect((pin.sha256 as Record<string, string>)[platform]).toMatch(/^[0-9a-f]{64}$/);
});

test("the installer is written whole: every pin filled, valid shell, and nothing runs before its last line", async () => {
  const script = await installScript();
  expect(script).not.toMatch(/__[A-Z0-9_]+__/);
  expect(script).toContain(`HERDR_VERSION="${pin.version}"`);
  for (const platform of HERDR_PLATFORMS) expect(script).toContain((pin.sha256 as Record<string, string>)[platform]!);
  // A download cut short must run nothing: the only command at the top level
  // after the settings is the last line.
  const lines = script.trimEnd().split("\n").filter((line) => line.trim() && !line.trimStart().startsWith("#"));
  expect(lines.at(-1)).toBe('main "$@"');
  const dir = mkdtempSync(join(tmpdir(), "shahi-install-"));
  try {
    writeFileSync(join(dir, "install"), script);
    const check = Bun.spawnSync(["sh", "-n", join(dir, "install")], { stdout: "ignore", stderr: "ignore" });
    expect(check.exitCode).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pin that is not a SHA-256 or a version stops the build instead of shipping", async () => {
  const sha = pin.sha256 as Record<string, string>;
  await expect(installScript(undefined, { ...pin, sha256: { ...sha, "linux-x86_64": "not-a-digest" } } as typeof pin)).rejects.toThrow("linux-x86_64");
  await expect(installScript(undefined, { ...pin, version: "latest" })).rejects.toThrow("not a version");
  await expect(installScript("echo __UNKNOWN__\n")).rejects.toThrow("placeholder");
});

// Every command that could install or start a service is a disposable shim.
// Only Bun's read-only readiness probe runs real code, against a loopback
// fixture authenticated by this test's key. PATH cannot find the owner's
// herdr, git, curl, service managers or agents; HOME and XDG roots are scratch.
const HERDR_STUB = `#!/bin/sh
printf 'herdr %s\\n' "$*" >> "$TEST_LOG"
case "$*" in
  --version) printf 'herdr %s\\n' "$TEST_VERSION" ;;
  'status server') [ -f "$TEST_STATE/server" ] && printf 'status: running\\n' ;;
  'plugin list --json')
    if [ -f "$TEST_STATE/plugin" ]; then
      printf '{"result":{"plugins":[{"plugin_id":"shahi","plugin_root":"%s","enabled":%s}]}}\\n' "$TEST_ROOT" "$TEST_ENABLED"
    else printf '{"result":{"plugins":[]}}\\n'; fi ;;
  'plugin install -y iYassr/shahi')
    [ "$TEST_INSTALL_FAIL" != 1 ] || exit 13
    touch "$TEST_STATE/plugin" ;;
  'plugin config-dir shahi') printf '%s\\n' "$TEST_CONFIG" ;;
  'plugin action invoke shahi.restart') [ "$TEST_NEVER_START" = service ] || touch "$TEST_STATE/service" ;;
  server) [ "$TEST_NEVER_START" != herdr ] || exit 27; touch "$TEST_STATE/server" "$TEST_STATE/service" ;;
  *) exit 17 ;;
esac
`;

interface InstallScenario {
  herdr?: boolean;
  running?: boolean;
  installed?: boolean;
  service?: boolean;
  wrongService?: boolean;
  disabled?: boolean;
  missing?: string[];
  version?: string;
  platform?: string;
  cpu?: string;
  download?: "fail" | "corrupt";
  installFail?: boolean;
  pairFail?: boolean;
  portValue?: string;
  quotedPort?: boolean;
  truncate?: boolean;
  neverStart?: "herdr" | "service";
}

async function installation(scenario: InstallScenario = {}) {
  const dir = mkdtempSync(join(tmpdir(), "shahi-installer-behavior-"));
  const home = join(dir, "home"), bin = join(dir, "bin"), state = join(dir, "state");
  const root = join(dir, "plugin-root"), config = join(dir, "config"), log = join(dir, "commands");
  for (const path of [home, bin, state, root, config, join(dir, "tmp")]) mkdirSync(path, { recursive: true });
  writeFileSync(log, "");
  const repo = fileURLToPath(new URL("../", import.meta.url));
  for (const name of ["plugin", "server", "shared", "node_modules", "tsconfig.json"]) {
    symlinkSync(join(repo, name), join(root, name));
  }
  const executable = (name: string, source: string) => {
    writeFileSync(join(bin, name), source); chmodSync(join(bin, name), 0o755);
  };
  const absent = new Set(scenario.missing ?? []);
  for (const tool of ["awk", "cut", "grep", "sed", "head", "nohup", "mkdir", "chmod", "mv", "mktemp", "rm", "touch", "shasum", "date"]) {
    if (!absent.has(tool)) symlinkSync(Bun.which(tool)!, join(bin, tool));
  }
  for (const tool of ["git", "unzip", "bash", "apt-get"]) {
    if (!absent.has(tool)) executable(tool, "#!/bin/sh\nexit 0\n");
  }
  // The background stub gets a scheduling opportunity, without making a
  // successful installation test wait the real service's half-second tick.
  executable("sleep", "#!/bin/sh\n/bin/sleep 0.01\n");
  executable("uname", `#!/bin/sh\nif [ "$1" = -s ]; then printf '%s\\n' "$TEST_PLATFORM"; else printf '%s\\n' "$TEST_CPU"; fi\n`);
  if (scenario.neverStart) {
    rmSync(join(bin, "date"));
    executable("date", `#!/bin/sh\nif [ -f "$TEST_STATE/clock" ]; then printf '200\\n'; else touch "$TEST_STATE/clock"; printf '100\\n'; fi\n`);
  }
  const downloaded = join(dir, "downloaded-herdr");
  writeFileSync(downloaded, HERDR_STUB);
  if (scenario.herdr !== false) executable("herdr", HERDR_STUB);
  if (!absent.has("curl")) executable("curl", `#!/bin/sh
printf 'curl %s\\n' "$*" >> "$TEST_LOG"
[ "$TEST_DOWNLOAD" != fail ] || exit 22
target=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then shift; target=$1; fi
  shift
done
[ -n "$target" ] || exit 19
/bin/cp "$TEST_BINARY" "$target"
if [ "$TEST_DOWNLOAD" = corrupt ]; then printf '\\n# changed\\n' >> "$target"; fi
`);
  if (!absent.has("bun")) executable("bun", `#!/bin/sh
if [ "$1" = -e ]; then exec "$TEST_REAL_BUN" "$@"; fi
printf 'bun %s\\n' "$*" >> "$TEST_LOG"
if [ "$*" = 'run server/scripts/pair.ts --no-copy' ]; then
  [ "$TEST_PAIR_FAIL" != 1 ] || exit 23
  printf 'Synthetic pairing QR\\n'
else exit 29; fi
`);
  for (const [name, present] of [["server", scenario.running !== false], ["plugin", scenario.installed !== false], ["service", scenario.service !== false]] as const) {
    if (present) writeFileSync(join(state, name), "");
  }
  const auth = new Auth({ passcodeHash: "", sessionSecret: "installer-test-key", sessionTtlMs: 60_000 });
  const requests: string[] = [];
  const fetch = (request: Request) => {
    requests.push(new URL(request.url).pathname);
    return Response.json({ authenticated: !scenario.wrongService && auth.verifyToken(readCookie(request.headers.get("cookie"), SESSION_COOKIE)) });
  };
  let server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch,
  });
  const listeningPort = server.port!;
  let awaitingStart = scenario.service === false;
  if (awaitingStart) server.stop(true);
  const startWatcher = setInterval(() => {
    if (awaitingStart && existsSync(join(state, "service"))) {
      awaitingStart = false;
      server = Bun.serve({ hostname: "127.0.0.1", port: listeningPort, fetch });
    }
  }, 10);
  const port = scenario.portValue ?? (scenario.quotedPort ? `"${listeningPort}"` : String(listeningPort));
  writeFileSync(join(config, ".env"), `SESSION_SECRET=installer-test-key\nPORT=${port}\n`, { mode: 0o600 });
  const digest = createHash("sha256").update(HERDR_STUB).digest("hex");
  const os = (scenario.platform ?? "Linux") === "Darwin" ? "macos" : "linux";
  const cpu = ["arm64", "aarch64"].includes(scenario.cpu ?? "x86_64") ? "aarch64" : "x86_64";
  const testPin = { ...pin, sha256: { ...pin.sha256, [`${os}-${cpu}`]: digest } } as typeof pin;
  const installer = join(dir, "install");
  const source = await installScript(undefined, testPin);
  writeFileSync(installer, scenario.truncate ? source.replace(/main "\$@"\s*$/, "") : source);
  const environment = {
    HOME: home, PATH: bin, TMPDIR: join(dir, "tmp"),
    XDG_CONFIG_HOME: config, XDG_STATE_HOME: state, XDG_DATA_HOME: join(dir, "data"),
    TEST_LOG: log, TEST_STATE: state, TEST_ROOT: root, TEST_CONFIG: config,
    TEST_VERSION: scenario.version ?? "0.9.3", TEST_ENABLED: scenario.disabled ? "false" : "true",
    TEST_PLATFORM: scenario.platform ?? "Linux", TEST_CPU: scenario.cpu ?? "x86_64",
    TEST_DOWNLOAD: scenario.download ?? "okay", TEST_BINARY: downloaded,
    TEST_INSTALL_FAIL: scenario.installFail ? "1" : "0", TEST_PAIR_FAIL: scenario.pairFail ? "1" : "0",
    TEST_NEVER_START: scenario.neverStart ?? "",
    TEST_REAL_BUN: process.execPath,
  };
  const run = async () => {
    const stdoutFile = join(dir, "stdout"), stderrFile = join(dir, "stderr");
    const child = Bun.spawn(["/bin/sh", installer], { cwd: home, env: environment, stdin: "ignore", stdout: Bun.file(stdoutFile), stderr: Bun.file(stderrFile), timeout: 10_000 });
    const exitCode = await child.exited;
    const stdout = readFileSync(stdoutFile, "utf8"), stderr = readFileSync(stderrFile, "utf8");
    return { stdout, stderr, exitCode, commands: readFileSync(log, "utf8"), installedBinary: existsSync(join(home, ".local/bin/herdr")) };
  };
  return { run, requests, cleanup: () => { clearInterval(startWatcher); server.stop(true); rmSync(dir, { recursive: true, force: true }); } };
}

describe("the public installer in a disposable environment", () => {
  test("a script download ending before its final main call changes nothing", async () => {
    const fixture = await installation({ truncate: true, herdr: false });
    try {
      const result = await fixture.run();
      expect(result.exitCode).toBe(0);
      expect(result.commands).toBe("");
      expect(result.stdout).toBe("");
      expect(result.installedBinary).toBe(false);
    } finally { fixture.cleanup(); }
  });

  test("an existing running installation only authenticates and makes a fresh code each time", async () => {
    const fixture = await installation();
    try {
      const first = await fixture.run(), second = await fixture.run();
      expect(first.exitCode, first.stderr).toBe(0);
      expect(second.exitCode, second.stderr).toBe(0);
      expect(second.commands.match(/bun run server\/scripts\/pair.ts --no-copy/g)).toHaveLength(2);
      expect(second.commands).not.toMatch(/plugin install|herdr server\n|shahi.restart|curl/);
      expect(fixture.requests).toEqual(["/api/auth/status", "/api/auth/status"]);
    } finally { fixture.cleanup(); }
  }, 15_000);

  for (const [platform, cpu, asset] of [["Linux", "x86_64", "linux-x86_64"], ["Linux", "aarch64", "linux-aarch64"], ["Darwin", "arm64", "macos-aarch64"], ["Darwin", "x86_64", "macos-x86_64"]]) {
    test(`a fresh ${asset} computer executes only its digest-verified herdr and starts the scratch installation`, async () => {
      const fixture = await installation({ herdr: false, installed: false, running: false, platform, cpu });
      try {
        const result = await fixture.run();
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.installedBinary).toBe(true);
        expect(result.commands).toContain(`herdr-${asset}`);
        expect(result.commands).toContain("herdr plugin install -y iYassr/shahi");
        expect(result.commands).toContain("herdr server\n");
        expect(result.stdout).toContain("checked against its SHA-256");
        expect(result.stdout).toContain("Synthetic pairing QR");
      } finally { fixture.cleanup(); }
    }, 15_000);
  }

  for (const download of ["fail", "corrupt"] as const) {
    test(`a ${download === "fail" ? "failed download" : "changed binary"} is never installed or run`, async () => {
      const fixture = await installation({ herdr: false, installed: false, download });
      try {
        const result = await fixture.run();
        expect(result.exitCode).toBe(1);
        expect(result.installedBinary).toBe(false);
        expect(result.commands).not.toMatch(/^herdr /m);
        expect(result.commands).not.toContain("bun run");
        expect(result.stderr).toContain(download === "fail" ? "could not download" : "expected SHA-256");
      } finally { fixture.cleanup(); }
    });
  }

  test("a running herdr with no Shahi service invokes its startup action before pairing", async () => {
    const fixture = await installation({ service: false });
    try {
      // An unavailable listener, unlike an answering unauthenticated one,
      // must permit the existing service's restart action.
      const result = await fixture.run();
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.commands).toContain("herdr plugin action invoke shahi.restart");
      expect(result.commands.indexOf("shahi.restart")).toBeLessThan(result.commands.indexOf("bun run"));
    } finally { fixture.cleanup(); }
  }, 15_000);

  test("another service on the configured port is refused before restart or pairing", async () => {
    const fixture = await installation({ wrongService: true });
    try {
      const result = await fixture.run();
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("refused this install's session key");
      expect(result.commands).not.toContain("bun run");
      expect(result.commands).not.toContain("shahi.restart");
      expect(result.stdout).not.toContain("Shahi's service is running");
    } finally { fixture.cleanup(); }
  }, 15_000);

  test("the authenticated probe accepts a quoted custom PORT as the service does", async () => {
    const fixture = await installation({ quotedPort: true });
    try {
      const result = await fixture.run();
      expect(result.exitCode, result.stderr).toBe(0);
    } finally { fixture.cleanup(); }
  }, 15_000);

  test("an invalid configured port is refused before any network or pairing request", async () => {
    const fixture = await installation({ portValue: "not-a-port" });
    try {
      const result = await fixture.run();
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("PORT must be a whole number");
      expect(result.commands).not.toContain("bun run");
      expect(fixture.requests).toEqual([]);
    } finally { fixture.cleanup(); }
  }, 15_000);

  for (const neverStart of ["herdr", "service"] as const) {
    test(`${neverStart} readiness expires by elapsed time rather than another unbounded probe`, async () => {
      const fixture = await installation({ neverStart, service: false, running: neverStart !== "herdr" });
      try {
        const result = await fixture.run();
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(neverStart === "herdr" ? "within 30 seconds" : "within a minute");
        expect(result.commands).not.toContain("bun run");
      } finally { fixture.cleanup(); }
    }, 15_000);
  }

  test("a disabled plugin stays disabled and explains how to re-enable it", async () => {
    const fixture = await installation({ disabled: true });
    try {
      const result = await fixture.run();
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("herdr plugin enable shahi");
      expect(result.commands).not.toContain("shahi.restart");
      expect(result.commands).not.toContain("bun run");
    } finally { fixture.cleanup(); }
  });

  for (const [version, message] of [["0.8.9", "older than Shahi supports"], ["not-a-version", "could not read a supported version"]]) {
    test(`an existing herdr ${version} is refused without replacing or starting it`, async () => {
      const fixture = await installation({ version });
      try {
        const result = await fixture.run();
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(message!);
        expect(result.commands).not.toMatch(/plugin install|herdr server\n|bun run|curl/);
      } finally { fixture.cleanup(); }
    });
  }

  test("missing plugin and bun dependencies are named before any download or installation", async () => {
    const fixture = await installation({ herdr: false, missing: ["git", "bun", "unzip", "bash"] });
    try {
      const result = await fixture.run();
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("sudo apt-get install -y git unzip bash");
      expect(result.commands).toBe("");
      expect(result.installedBinary).toBe(false);
    } finally { fixture.cleanup(); }
  });

  for (const [scenario, message] of [[{ installFail: true, installed: false }, "could not install the Shahi plugin"], [{ pairFail: true }, "pairing code could not be made"]] as const) {
    test(`an unsuccessful step never reports Done: ${message}`, async () => {
      const fixture = await installation(scenario);
      try {
        const result = await fixture.run();
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(message);
        expect(result.stdout).not.toContain("\u001b[1mDone");
      } finally { fixture.cleanup(); }
    }, 15_000);
  }
});
