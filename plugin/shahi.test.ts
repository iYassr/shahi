import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { layoutFromEnv, type Layout } from "./layout";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Scratch directories made below, removed when the file finishes. Some hold
// generated secrets, and every run left them in $TMPDIR until the September
// 2026 review.
const scratches: string[] = [];
const scratch = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratches.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
});
import { Auth, readCookie, SESSION_COOKIE } from "../server/lib/auth";
import { loadConfig } from "../server/lib/config";
import { readEnvFile } from "../server/lib/secrets";
import { atomicJson } from "./releases/storage";
import { unsupervised, type Service, type ServiceSpec } from "./service";
import {
  bunPath,
  DEFAULT_RELAY_URL,
  install,
  lingerHint,
  openPair,
  openPairFailure,
  pairPopup,
  popupSteps,
  relayUrlFor,
  serviceSpec,
  setup,
  status,
  waitForStart,
  type PopupSteps,
} from "./shahi";

const layout = layoutFromEnv({
  HERDR_PLUGIN_ROOT: "/Users/me/herdr/plugins/github/shahi",
  HERDR_PLUGIN_CONFIG_DIR: "/Users/me/Library/Application Support/herdr/plugins/shahi",
  HERDR_PLUGIN_STATE_DIR: "/Users/me/.local/state/herdr/plugins/shahi",
  HERDR_SOCKET_PATH: "/Users/me/.config/herdr/sessions/work/herdr.sock",
} as NodeJS.ProcessEnv);

describe("relayUrlFor", () => {
  test("an env that says nothing gets Shahi's relay, so the first pairing code works from anywhere", () => {
    expect(relayUrlFor(new Map([["SESSION_SECRET", "s"]]))).toBe(DEFAULT_RELAY_URL);
  });

  test("an empty RELAY_URL is a decision — direct only", () => {
    expect(relayUrlFor(new Map([["RELAY_URL", ""]]))).toBeNull();
  });

  test("a relay of one's own is kept", () => {
    expect(relayUrlFor(new Map([["RELAY_URL", "https://relay.example"]]))).toBe("https://relay.example");
  });
});

describe("the service's environment", () => {
  test("carries the default relay, since it is not in the .env the sidecar loads", () => {
    expect(serviceSpec(layout, new Map(), "/opt/homebrew/bin/bun").env.RELAY_URL).toBe(DEFAULT_RELAY_URL);
  });

  test("carries none when the .env turned it off, and the user's when they set one", () => {
    expect(serviceSpec(layout, new Map([["RELAY_URL", ""]]), "/opt/homebrew/bin/bun").env).not.toHaveProperty("RELAY_URL");
    expect(serviceSpec(layout, new Map([["RELAY_URL", "https://relay.example"]]), "/opt/homebrew/bin/bun").env.RELAY_URL).toBe(
      "https://relay.example",
    );
  });
});

describe("lingerHint", () => {
  test("says the one command a headless Linux box needs, only when lingering is off", () => {
    expect(lingerHint("linux", "no\n", "op")).toContain("loginctl enable-linger op");
    expect(lingerHint("linux", "yes\n", "op")).toBeNull();
    // No loginctl (a container, a distro without it): nothing to say.
    expect(lingerHint("linux", null, "op")).toBeNull();
    expect(lingerHint("darwin", "no", "op")).toBeNull();
  });
});

/**
 * Found by installing on a real Ubuntu (2026-09-04), which is the only place
 * it shows: `bun run` prepends a node-compatibility shim directory to PATH,
 * so the startup hook's `Bun.which("bun")` answered `/tmp/bun-node-<hash>/bun`
 * and that went into `ExecStart=`. /tmp does not survive a reboot, so the
 * service came back pointing at a missing binary and failed forever under
 * `Restart=always` — masked in daily use because the hook re-renders the unit
 * on every herdr start.
 */
describe("bunPath, against bun's temporary node shim", () => {
  const withPath = <T,>(dirs: string[], fn: () => T): T => {
    const before = process.env.PATH;
    process.env.PATH = dirs.join(":");
    try {
      return fn();
    } finally {
      process.env.PATH = before;
    }
  };

  test("never returns a bun under the temp directory, even when it is first on PATH", () => {
    const shim = scratch("bun-node-");
    writeFileSync(join(shim, "bun"), "#!/bin/sh\nexit 7\n");
    chmodSync(join(shim, "bun"), 0o755);

    const chosen = withPath([shim, dirname(process.execPath)], () => bunPath());
    expect(chosen).not.toBe(join(shim, "bun"));
    expect(chosen.startsWith(`${tmpdir()}/`)).toBe(false);
    expect(chosen).not.toContain("/bun-node-");
    expect(chosen).not.toContain("/node_modules/");
    // Whatever it picks must be a path that outlives a reboot. Which stable
    // bun it is depends on the machine — on a Homebrew Mac the PATH one
    // (/opt/homebrew/bin/bun) is deliberately preferred over process.execPath,
    // because the Cellar path a brew upgrade deletes is the one execPath gives.
    expect(chosen.startsWith("/")).toBe(true);
  });

  test("the unit's PATH does not carry the shim either, so it cannot go stale", () => {
    const shim = scratch("bun-node-");
    const spec = withPath([shim, "/usr/bin"], () => serviceSpec(layout, new Map(), "/opt/homebrew/bin/bun"));
    expect(spec.env.PATH).not.toContain(shim);
    expect(spec.env.PATH).toContain("/usr/bin");
  });
});

/** Everything a setup touches, under a fresh temporary directory; the herdr socket does not exist. */
function scratchLayout(): Layout {
  const dir = scratch("shahi-setup-");
  return layoutFromEnv({
    HERDR_PLUGIN_ROOT: join(dir, "root"),
    HERDR_PLUGIN_CONFIG_DIR: join(dir, "config dir"),
    HERDR_PLUGIN_STATE_DIR: join(dir, "state"),
    HERDR_SOCKET_PATH: join(dir, "no-herdr.sock"),
  } as NodeJS.ProcessEnv);
}

/** An approved release already staged, so `bootstrap` needs no network. */
function stagedRelease(layout: Layout): void {
  const managed = join(layout.stateDir, "managed");
  mkdirSync(join(managed, "releases", "test-build"), { recursive: true });
  writeFileSync(join(managed, "releases", "test-build", "manager.js"), "// the approved manager\n");
  writeFileSync(join(managed, "installation.json"), JSON.stringify({ active: { version: "0.0.0", buildId: "test-build" }, channel: "stable", sequence: {} }));
}

function fakeService(install: (spec: ServiceSpec) => void = () => {}, running = false): Service {
  return {
    kind: "launchd",
    path: "/nonexistent/app.shahi.sidecar.plist",
    inspect: "true",
    render: () => "",
    install,
    stop() {},
    status: () => ({ installed: true, running, pid: null }),
    remove() {},
  };
}

/** A port nothing listens on, for as long as the test runs. */
function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

/**
 * A sidecar on the port the layout's .env names (a fresh one unless it names
 * one): this install's when `ours`, which is to say it accepts a session
 * signed with the key in that .env, the way the real one does; another
 * program's Shahi otherwise. `after` delays it, as a slow cold start would.
 */
function sidecar(layout: Layout, { ours = true, after = 0 } = {}) {
  mkdirSync(layout.configDir, { recursive: true });
  let port = Number(readEnvFile(layout.envFile).get("PORT"));
  if (!port) {
    port = freePort();
    appendFileSync(layout.envFile, `PORT=${port}\n`);
  }
  const started = { at: 0 };
  let server: ReturnType<typeof Bun.serve> | undefined;
  const serve = () => {
    started.at = Date.now();
    server = Bun.serve({ hostname: "127.0.0.1", port, fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/api/auth/status") {
        const secret = readEnvFile(layout.envFile).get("SESSION_SECRET") ?? "";
        const token = readCookie(req.headers.get("cookie"), SESSION_COOKIE);
        const accepted = ours && !!secret && new Auth({ passcodeHash: "", sessionSecret: secret, sessionTtlMs: 60_000 }).verifyToken(token);
        return Response.json({ required: true, authenticated: accepted });
      }
      if (path === "/api/meta") return Response.json({ serverId: "s".repeat(43), serverVersion: ours ? "9.9.9-ours" : "1.0.0-theirs", api: { min: 5, max: 5 } });
      return new Response("not here", { status: 404 });
    } });
  };
  const timer = after ? setTimeout(serve, after) : (serve(), undefined);
  restore.push(() => { clearTimeout(timer); void server?.stop(true); });
  return { port, started };
}

const realFetch = globalThis.fetch;
const restore: (() => void)[] = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  while (restore.length) restore.pop()!();
});

/** What the command printed, as one string, for as long as the test runs. */
function captured() {
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
  const error = spyOn(console, "error").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
  restore.push(() => { log.mockRestore(); error.mockRestore(); });
  return { text: () => lines.join("\n") };
}

function offline() {
  globalThis.fetch = (() => Promise.reject(new Error("simulated: network unavailable"))) as unknown as typeof fetch;
}

function withEnv(values: Record<string, string>) {
  const before = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  Object.assign(process.env, values);
  restore.push(() => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

/** A stand-in for herdr that writes down every call, then runs `answer`. */
function fakeHerdr(answer = "exit 0"): { calls: () => string } {
  const dir = scratch("shahi-fake-herdr-");
  const record = join(dir, "calls.txt");
  const bin = join(dir, "herdr");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${record}'\n${answer}\n`);
  chmodSync(bin, 0o755);
  withEnv({ HERDR_BIN_PATH: bin });
  return { calls: () => (existsSync(record) ? readFileSync(record, "utf8") : "") };
}

/**
 * The pair popup is where a first run happens (`herdr plugin install`, then
 * `shahi.pair`), and herdr closes a popup the moment its command exits. The
 * pre-release review found both halves of that: a failed setup flashed and
 * vanished, and a working one had its passcode and lingering warning painted
 * over by the QR's screen within a second, then closed with it.
 */
describe("the pair popup", () => {
  function steps(over: Partial<PopupSteps>, order: string[]): PopupSteps {
    return {
      running: async () => { order.push("running"); return false; },
      setup: async () => { order.push("setup"); },
      showCode: async () => { order.push("qr"); return 0; },
      ...over,
    };
  }

  test("a setup that fails stays on screen, with what to do next, until Enter", async () => {
    const out = captured();
    const order: string[] = [];
    let onScreenAtEnter = "";
    const code = await pairPopup(
      () => steps({ setup: async () => { order.push("setup"); throw new Error("Could not set up Shahi's approved release: offline"); } }, order),
      async () => { order.push("enter"); onScreenAtEnter = out.text(); },
    );
    expect(code).toBe(1);
    expect(order).toEqual(["running", "setup", "enter"]);
    expect(onScreenAtEnter).toContain("Could not set up Shahi's approved release: offline");
    expect(onScreenAtEnter).toContain("herdr plugin action invoke shahi.pair");
    expect(onScreenAtEnter).toContain("herdr plugin action invoke shahi.status");
    expect(onScreenAtEnter).toContain("Press Enter to close");
  });

  test("so does anything that fails before setup starts, such as finding the service", async () => {
    const out = captured();
    let entered = 0;
    const code = await pairPopup(() => { throw new Error("No systemd on this machine"); }, async () => { entered++; });
    expect(code).toBe(1);
    expect(entered).toBe(1);
    expect(out.text()).toContain("No systemd on this machine");
  });

  test("a setup that works is held until Enter, before the QR's screen covers the passcode", async () => {
    const out = captured();
    const order: string[] = [];
    let onScreenAtEnter = "";
    const code = await pairPopup(
      () => steps({ setup: async () => { order.push("setup"); console.log("  Passcode  4821"); } }, order),
      async () => { order.push("enter"); onScreenAtEnter = out.text(); },
    );
    expect(code).toBe(0);
    expect(order).toEqual(["running", "setup", "enter", "qr"]);
    expect(onScreenAtEnter).toContain("Passcode  4821");
    expect(onScreenAtEnter).toContain("Press Enter to show the QR code");
  });

  test("a running sidecar goes straight to the QR, with no extra Enter", async () => {
    captured();
    const order: string[] = [];
    const code = await pairPopup(() => steps({ running: async () => { order.push("running"); return true; } }, order), async () => { order.push("enter"); });
    expect(code).toBe(0);
    expect(order).toEqual(["running", "qr"]);
  });

  test("a QR that could not be made is held too", async () => {
    const out = captured();
    const order: string[] = [];
    const code = await pairPopup(
      () => steps({ running: async () => true, showCode: async () => { order.push("qr"); return 1; } }, order),
      async () => { order.push("enter"); },
    );
    expect(code).toBe(1);
    expect(order).toEqual(["qr", "enter"]);
    expect(out.text()).toContain("Press Enter to close");
  });

  // The Enter before the QR is new, and it is how this showed: read through
  // `Bun.stdin.stream()`, the popup kept reading fd 0 after its lock was
  // released and swallowed the Enter meant for the QR screen, which then
  // never closed. Measured in a PTY and over a pipe alike.
  test("the Enter after setup leaves the next Enter to the QR screen", async () => {
    const script = `import { readLine } from ${JSON.stringify(join(import.meta.dir, "shahi.ts"))};
console.log("POPUP:" + (await readLine()));
const qr = Bun.spawn([process.execPath, "-e", "process.stdin.once('data', d => { console.log('QR:' + String(d).trim()); process.exit(0); }); console.log('QR-WAITING');"], { stdin: "inherit", stdout: "inherit" });
console.log("QR-EXIT:" + (await qr.exited));`;
    const proc = Bun.spawn([process.execPath, "-e", script], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    let out = "";
    const reading = (async () => { for await (const chunk of proc.stdout) out += new TextDecoder().decode(chunk); })();
    const until = async (what: string) => {
      for (const end = Date.now() + 5000; Date.now() < end && !out.includes(what); ) await Bun.sleep(20);
    };
    try {
      proc.stdin.write("setup-seen\n");
      await proc.stdin.flush();
      await until("QR-WAITING");
      proc.stdin.write("close\n");
      await proc.stdin.flush();
      await until("QR-EXIT");
      expect(out).toContain("POPUP:setup-seen");
      expect(out).toContain("QR:close");
      expect(out).toContain("QR-EXIT:0");
    } finally {
      proc.kill();
      await reading;
    }
  }, 15_000);
});

/**
 * A quoted PORT went into the unit as `PORT="7275"`, the sidecar read NaN
 * and crashed on every start, and setup said "not answering at
 * http://127.0.0.1:NaN" (pre-release bug hunt).
 */
describe("a PORT written by hand in the .env", () => {
  test('PORT="7275" reaches the service as 7275, not NaN', async () => {
    const out = captured();
    const layout = scratchLayout();
    stagedRelease(layout);
    mkdirSync(layout.configDir, { recursive: true });
    writeFileSync(layout.envFile, 'PORT="7275"\n');
    let spec: ServiceSpec | undefined;
    offline();
    await install(layout, fakeService((s) => { spec = s; }));
    expect(spec?.env.PORT).toBe("7275");
    expect(out.text()).not.toContain("NaN");
  }, 40_000);

  test("a PORT that is not a port stops setup before the service, naming the file to fix", async () => {
    captured();
    const layout = scratchLayout();
    stagedRelease(layout);
    mkdirSync(layout.configDir, { recursive: true });
    writeFileSync(layout.envFile, "PORT=72o5\n");
    let installed = 0;
    await expect(install(layout, fakeService(() => { installed++; }))).rejects.toThrow(
      `PORT must be a whole number from 1 to 65535, not "72o5". Fix it in ${layout.envFile}`,
    );
    expect(installed).toBe(0);
  });
});

describe("the first setup's passcode", () => {
  // Reproduced in the pre-release review with the catalog download failing:
  // the hash was written before the release was fetched, the passcode was
  // printed only at the end, and every later run kept the hash of a passcode
  // nobody had seen.
  test("is not used up by a setup that fails to fetch the release", async () => {
    captured();
    offline();
    const layout = scratchLayout();
    let installed = 0;
    for (const attempt of [1, 2]) {
      await expect(install(layout, fakeService(() => { installed++; }))).rejects.toThrow(/approved release.*network unavailable/);
      expect(readEnvFile(layout.envFile).get("PASSCODE_HASH_B64") ?? "", `attempt ${attempt}`).toBe("");
    }
    expect(installed).toBe(0);
  });

  test("is printed the moment its hash is kept, so a service that fails to start cannot hide it", async () => {
    const out = captured();
    const layout = scratchLayout();
    stagedRelease(layout);
    await expect(install(layout, fakeService(() => { throw new Error("launchctl bootstrap failed"); }))).rejects.toThrow(/launchctl/);
    const printed = out.text().match(/Passcode {2}(\d{4})/)?.[1];
    expect(printed).toBeDefined();
    const hash = Buffer.from(readEnvFile(layout.envFile).get("PASSCODE_HASH_B64")!, "base64").toString("utf8");
    expect(await Bun.password.verify(printed!, hash)).toBe(true);
  });

  test("can be replaced, since only its hash is kept: reset-passcode prints a new one and restarts", async () => {
    const out = captured();
    const layout = scratchLayout();
    stagedRelease(layout);
    sidecar(layout);
    await install(layout, fakeService());
    const first = readEnvFile(layout.envFile).get("PASSCODE_HASH_B64");

    let restarted = 0;
    await install(layout, fakeService(() => { restarted++; }), { newPasscode: true });
    const printed = [...out.text().matchAll(/Passcode {2}(\d{4})/g)].map((m) => m[1]!);
    expect(printed).toHaveLength(2);
    const hash = readEnvFile(layout.envFile).get("PASSCODE_HASH_B64")!;
    expect(hash).not.toBe(first);
    expect(await Bun.password.verify(printed[1]!, Buffer.from(hash, "base64").toString("utf8"))).toBe(true);
    expect(restarted).toBe(1);
  });
});

/**
 * herdr ignores a failed startup hook, and the plugin toasted only success, so
 * a failure was silent everywhere but the plugin log (pre-release review).
 */
test("a setup that fails says so in herdr's tray, and where the rest is", async () => {
  captured();
  offline();
  const herdr = fakeHerdr();
  await expect(setup(scratchLayout(), fakeService())).rejects.toThrow(/approved release/);
  expect(herdr.calls()).toContain("notification show Shahi is not set up");
  expect(herdr.calls()).toContain("herdr plugin log list --plugin shahi");
});

/**
 * Every hint said a bare `herdr`, which outside a named session's panes
 * reaches the default session: the printed commands failed with
 * server_not_running, and "Run `herdr` to attach" started the default
 * session, whose startup hook moved Shahi to it (pre-release bug hunt).
 */
describe("hints for someone running herdr as a named session", () => {
  const qa = join(homedir(), ".config", "herdr", "sessions", "qa", "herdr.sock");

  test("the setup failure toast names the session in every command", async () => {
    captured();
    offline();
    withEnv({ HERDR_SOCKET_PATH: qa });
    const herdr = fakeHerdr();
    await expect(setup(scratchLayout(), fakeService())).rejects.toThrow(/approved release/);
    const toast = herdr.calls();
    expect(toast).toContain("herdr --session qa plugin log list --plugin shahi");
    expect(toast).toContain("herdr --session qa plugin action invoke shahi.pair");
    expect(toast).not.toMatch(/(^|[^-\w])herdr plugin/);
  });

  test("the popup's failure text and the attach advice name it too", async () => {
    const out = captured();
    withEnv({ HERDR_SOCKET_PATH: qa });
    await pairPopup(() => { throw new Error("offline"); }, async () => {});
    expect(out.text()).toContain("herdr --session qa plugin action invoke shahi.pair");
    expect(out.text()).toContain("herdr --session qa plugin action invoke shahi.status");
    const said = openPairFailure('{"error":{"code":"plugin_pane_open_failed","message":"no active workspace"}}', null);
    expect(said).toContain("Run `herdr --session qa` in a terminal to attach");
  });
});

/**
 * The Alpine guidance was a dead end (pre-release review): every verb threw
 * before a secret existed, `status` included, and the command offered could
 * not start. Now everything but supervision happens.
 */
describe("a Linux without systemd", () => {
  test("gets its secrets and a command that starts the sidecar with them", async () => {
    captured();
    const layout = scratchLayout();
    stagedRelease(layout);
    mkdirSync(layout.configDir, { recursive: true });
    writeFileSync(layout.envFile, `PORT=${freePort()}\n`); // nothing answers there
    let said = "";
    await install(layout, unsupervised()).catch((err: Error) => { said = err.message; });
    expect(said).toContain("No systemd on this machine");
    const command = said.split("\n").find((line) => line.trimStart().startsWith("cd "))!;
    for (const part of ["SHAHI_ENV_FILE=", "SHAHI_DATA=", `RELAY_URL='${DEFAULT_RELAY_URL}'`, "SHAHI_MANAGER_ROOT=", "manager.js"]) {
      expect(command).toContain(part);
    }
    // What the sidecar reads at start: the .env the command names now holds a
    // session key and a passcode, so it does not die on either.
    const envFile = command.match(/SHAHI_ENV_FILE='([^']+)'/)![1]!;
    expect(envFile).toBe(layout.envFile);
    expect(() => loadConfig({ SHAHI_ENV_FILE: envFile })).not.toThrow();
  });

  test("still answers status", async () => {
    const out = captured();
    const layout = scratchLayout();
    mkdirSync(layout.configDir, { recursive: true });
    writeFileSync(layout.envFile, "PORT=1\n"); // nothing listens on port 1
    expect(await status(layout, unsupervised())).toBe(1);
    expect(out.text()).toContain("none (no systemd)");
    expect(out.text()).toContain(layout.envFile);
  });

  // Measured on Alpine: with the printed command running under the box's
  // own init, every herdr start marked the startup hook failed, toasted
  // "Shahi is not set up" and skipped the update request a reinstall should
  // leave (pre-release bug hunt).
  test("a sidecar started by hand and answering is reported running, not 'not set up', and gets the update request", async () => {
    const out = captured();
    const layout = scratchLayout();
    stagedRelease(layout);
    sidecar(layout);
    const herdr = fakeHerdr();
    expect(await setup(layout, unsupervised())).toBe(0);
    expect(out.text()).toContain("Shahi is running at");
    expect(out.text()).toContain("started outside herdr");
    expect(out.text()).toContain("manager.js");
    expect(out.text()).not.toContain("Shahi is not running");
    expect(herdr.calls()).toContain("notification show Shahi is running");
    expect(herdr.calls()).not.toContain("not set up");
    expect(JSON.parse(readFileSync(join(layout.stateDir, "managed", "request.json"), "utf8"))).toEqual({ action: "install" });
  });

  test("with nothing answering, the hand-over says it is not running, and still leaves the update request", async () => {
    captured();
    const layout = scratchLayout();
    stagedRelease(layout);
    mkdirSync(layout.configDir, { recursive: true });
    writeFileSync(layout.envFile, `PORT=${freePort()}\n`);
    await expect(install(layout, unsupervised())).rejects.toThrow(/^Shahi is not running\. No systemd on this machine/);
    expect(existsSync(join(layout.stateDir, "managed", "request.json"))).toBe(true);
  });
});

/**
 * Any Shahi's /api/meta used to count as this install running: another
 * user's, or a development checkout on the default port. Setup printed
 * "running", status exited 0 with the other server's version, and the popup
 * went straight to a pair.ts that failed with a 401 blaming SESSION_SECRET,
 * while the real sidecar crash-looped on EADDRINUSE (pre-release bug hunt).
 */
describe("another program on Shahi's port", () => {
  test("setup reports the port taken and how to move, instead of 'running'", async () => {
    const out = captured();
    const layout = scratchLayout();
    stagedRelease(layout);
    sidecar(layout, { ours: false });
    const herdr = fakeHerdr();
    expect(await setup(layout, fakeService(() => {}, true))).toBe(1);
    expect(out.text()).toContain("Another program is answering at");
    expect(out.text()).toContain(`Put PORT=<a free port> in ${layout.envFile}`);
    expect(out.text()).not.toContain("is running at");
    expect(herdr.calls()).toContain("port is taken");
  });

  test("status says so and exits 1, without the other server's version or devices", async () => {
    const out = captured();
    const layout = scratchLayout();
    sidecar(layout, { ours: false });
    appendFileSync(layout.envFile, `SESSION_SECRET=${"k".repeat(43)}\n`);
    expect(await status(layout, fakeService(() => {}, true))).toBe(1);
    expect(out.text()).toContain("port taken");
    expect(out.text()).not.toContain("1.0.0-theirs");
  });

  test("the popup does not take it for a running sidecar, and does not go on to a code", async () => {
    const out = captured();
    const layout = scratchLayout();
    stagedRelease(layout);
    sidecar(layout, { ours: false });
    let shown = 0;
    // The real steps, with a launchd job that is running and pair.ts counted, not run.
    const code = await pairPopup(() => ({ ...popupSteps(layout, fakeService(() => {}, true), []), showCode: async () => { shown++; return 0; } }), async () => {});
    expect(code).toBe(1);
    expect(shown).toBe(0);
    expect(out.text()).toContain("Another program is answering at");
  });

  test("this install's own sidecar is still recognised as running", async () => {
    const out = captured();
    const layout = scratchLayout();
    stagedRelease(layout);
    sidecar(layout);
    expect((await install(layout, fakeService(() => {}, true))).state).toBe("answering");
    expect(out.text()).toContain("Shahi's connection service is running at");
    expect(await status(layout, fakeService(() => {}, true))).toBe(0);
    expect(out.text()).toContain("9.9.9-ours");
  });
});

/**
 * Setup waited a fixed 6 s, and a healthy cold start on a loaded VM took up
 * to 7.8 s, so restart said "not answering … The log says why" and toasted
 * "Shahi did not start" for a service that answered a moment later
 * (pre-release bug hunt).
 */
describe("a sidecar that starts slowly", () => {
  test("answering after 7 s is reported running, not as a failure", async () => {
    const out = captured();
    const layout = scratchLayout();
    stagedRelease(layout);
    sidecar(layout, { after: 7_000 });
    const herdr = fakeHerdr();
    expect(await setup(layout, fakeService(() => {}, true))).toBe(0);
    expect(out.text()).toContain("Shahi's connection service is running at");
    expect(out.text()).not.toContain("The log says why");
    expect(herdr.calls()).toContain("notification show Shahi is running");
  }, 20_000);

  test("still running but silent when the wait ends is 'still starting', not 'did not start'", async () => {
    const layout = scratchLayout();
    const env = new Map([["SESSION_SECRET", "k".repeat(43)]]);
    const url = `http://127.0.0.1:${freePort()}`;
    expect(await waitForStart(url, env, fakeService(() => {}, true), join(layout.stateDir, "managed"), Date.now(), 1_000)).toEqual({ state: "starting" });
  });

  test("a service that stays stopped, or that its manager says exited, is a failure at once", async () => {
    const layout = scratchLayout();
    const env = new Map([["SESSION_SECRET", "k".repeat(43)]]);
    const url = `http://127.0.0.1:${freePort()}`;
    const root = join(layout.stateDir, "managed");
    const since = Date.now();
    const stopped = Date.now();
    expect(await waitForStart(url, env, fakeService(() => {}, false), root, since, 20_000)).toEqual({ state: "failed", why: null });
    expect(Date.now() - stopped).toBeLessThan(8_000);
    atomicJson(join(root, "status.json"), { managed: true, phase: "failed", channel: "stable", current: "0.3.7", message: "The service exited with code 1." });
    expect(await waitForStart(url, env, fakeService(() => {}, true), root, since, 20_000)).toEqual({ state: "failed", why: "The service exited with code 1." });
    // A record from before this start says nothing about it.
    expect(await waitForStart(url, env, fakeService(() => {}, true), root, Date.now() + 60_000, 500)).toEqual({ state: "starting" });
  }, 20_000);
});

/**
 * Measured in the pre-release review against a headless herdr with no client:
 * `herdr plugin action invoke shahi.pair` answers "running" and exits 0 before
 * the action starts, the popup cannot open ("no active workspace"), and the
 * plugin log held only herdr's JSON.
 */
describe("a pairing popup that cannot open", () => {
  const noWorkspace = '{"error":{"code":"plugin_pane_open_failed","message":"no active workspace"},"id":"cli:plugin"}';

  test("says why in plain words, and how to pair without a window", () => {
    withEnv({ HERDR_SOCKET_PATH: join(homedir(), ".config", "herdr", "herdr.sock") });
    const said = openPairFailure(noWorkspace, layout);
    expect(said).toContain("Could not open the pairing popup: no active workspace.");
    expect(said).toContain("Run `herdr` in a terminal to attach");
    expect(said).toContain(`SHAHI_ENV_FILE='${layout.envFile}'`);
    expect(said).toContain("server/scripts/pair.ts --code-only");
    expect(said).not.toContain('{"error"');
  });

  test("the action reports it to the plugin log and fails", () => {
    const out = captured();
    const scratch = scratchLayout();
    fakeHerdr(`case "$1 $2" in "plugin pane") echo '${noWorkspace}' >&2; exit 1;; esac`);
    withEnv({
      HERDR_PLUGIN_ROOT: scratch.root,
      HERDR_PLUGIN_CONFIG_DIR: scratch.configDir,
      HERDR_PLUGIN_STATE_DIR: scratch.stateDir,
      HERDR_SOCKET_PATH: scratch.socketPath,
    });
    expect(openPair()).toBe(1);
    expect(out.text()).toContain("no active workspace");
    expect(out.text()).toContain("--code-only");
  });
});
