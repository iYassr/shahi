import { describe, expect, test } from "bun:test";
import { layoutFromEnv } from "./layout";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bunPath, DEFAULT_RELAY_URL, lingerHint, relayUrlFor, serviceSpec } from "./shahi";

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
    const shim = mkdtempSync(join(tmpdir(), "bun-node-"));
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
    const shim = mkdtempSync(join(tmpdir(), "bun-node-"));
    const spec = withPath([shim, "/usr/bin"], () => serviceSpec(layout, new Map(), "/opt/homebrew/bin/bun"));
    expect(spec.env.PATH).not.toContain(shim);
    expect(spec.env.PATH).toContain("/usr/bin");
  });
});
