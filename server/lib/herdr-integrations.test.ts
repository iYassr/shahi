import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrCli, keepReaderIntegrations, parseIntegrationStatus, type IntegrationDeps } from "./herdr-integrations";

const scratches: string[] = [];
afterAll(() => { for (const dir of scratches) rmSync(dir, { recursive: true, force: true }); });
const seenPath = () => {
  const dir = mkdtempSync(join(tmpdir(), "shahi-integrations-"));
  scratches.push(dir);
  return join(dir, "herdr-integrations.json");
};

/** `herdr integration status` from herdr 0.9.1, as printed on a Mac on 2026-09-28. */
const STATUS = [
  "pi: not installed (/Users/me/.pi/agent/extensions/herdr-agent-state.ts)",
  "claude: outdated (v9 < v10) (/Users/me/.claude/hooks/herdr-agent-state.sh)",
  "codex: current (v8) (/Users/me/.codex/herdr-agent-state.sh)",
  "opencode: outdated (v11 < v12) (/Users/me/.config/opencode/plugins/herdr-agent-state.js)",
  "cursor: current (v1) (/Users/me/.cursor/herdr-agent-state.sh)",
  "antigravity-cli: current (v3) (/Users/me/.gemini/config/hooks/herdr-agent-state.sh)",
  "letta (experimental): not installed (/Users/me/.letta/hooks/herdr-agent-session.sh)",
].join("\n");

const status = (states: Record<string, string>) =>
  Object.entries(states).map(([name, state]) => `${name}: ${state} (/Users/me/.${name}/herdr-agent-state.sh)`).join("\n");

/** A herdr that answers `status` with `text` and records every install it is asked for. */
function fake(text: string, over: Partial<IntegrationDeps> & { failInstall?: boolean } = {}) {
  const installs: string[] = [];
  const asked: string[][] = [];
  const deps: IntegrationDeps = {
    herdr: async (args) => {
      if (args[1] === "status") return { ok: true, out: text, reason: "" };
      installs.push(args[2]!);
      return over.failInstall ? { ok: false, out: "", reason: "permission denied" } : { ok: true, out: "", reason: "" };
    },
    installed: async (kinds) => { asked.push(kinds); return kinds; },
    seenPath: seenPath(),
    ...over,
  };
  return { deps, installs, asked };
}

describe("herdr integration status", () => {
  test("reads each state, experimental ones included, and nothing else", () => {
    const states = parseIntegrationStatus(`${STATUS}\ninstalled herdr integrations need updating; run herdr integration install claude.`);
    expect(Object.fromEntries(states)).toEqual({
      pi: "missing", claude: "outdated", codex: "current", opencode: "outdated",
      cursor: "current", "antigravity-cli": "current", letta: "missing",
    });
  });
});

describe("keeping Reader's integrations installed", () => {
  // The TestFlight report: Claude detected, no session id, Reader empty.
  test("a missing Claude integration is installed when Claude is on this computer, with no command typed", async () => {
    const { deps, installs } = fake(status({ claude: "not installed", codex: "current" }));
    const said = await keepReaderIntegrations(deps);
    expect(installs).toEqual(["claude"]);
    expect(said.join("\n")).toContain("Installed herdr's Claude integration");
    expect(JSON.parse(readFileSync(deps.seenPath, "utf8"))).toEqual(["claude", "codex"]);
  });

  test("an agent that is not on this computer gets no integration, and so no settings folder", async () => {
    const { deps, installs } = fake(status({ claude: "not installed", opencode: "not installed" }), {
      installed: async () => ["opencode"],
    });
    await keepReaderIntegrations(deps);
    expect(installs).toEqual(["opencode"]);
  });

  test("an integration this computer has had and lost was removed by someone, and stays removed", async () => {
    const { deps, installs } = fake(status({ claude: "current" }));
    await keepReaderIntegrations(deps);
    const removed = fake(status({ claude: "not installed" }), { seenPath: deps.seenPath });
    expect(await keepReaderIntegrations(removed.deps)).toEqual([]);
    expect([...installs, ...removed.installs]).toEqual([]);
  });

  test("outdated integrations are updated without starting a shell to look for agents", async () => {
    const { deps, installs, asked } = fake(STATUS);
    const said = await keepReaderIntegrations(deps);
    expect(installs).toEqual(["claude", "opencode"]);
    expect(asked).toEqual([]);
    expect(said).toEqual(["Updated herdr's Claude integration.", "Updated herdr's OpenCode integration."]);
  });

  test("Antigravity's integration has its own name in herdr", async () => {
    const { deps, installs } = fake("antigravity-cli: not installed (/Users/me/.gemini/config/hooks/herdr-agent-state.sh)");
    await keepReaderIntegrations(deps);
    expect(installs).toEqual(["antigravity-cli"]);
  });

  test("everything current costs one herdr call and writes nothing new", async () => {
    const path = seenPath();
    writeFileSync(path, JSON.stringify(["antigravity-cli", "claude", "codex", "cursor", "opencode"]));
    const { deps, installs, asked } = fake(status({ claude: "current (v10)", codex: "current (v8)" }), { seenPath: path });
    expect(await keepReaderIntegrations(deps)).toEqual([]);
    expect(installs).toEqual([]);
    expect(asked).toEqual([]);
  });

  test("a herdr without the command, a failed install or a failed search is said, never thrown", async () => {
    const old = fake("");
    old.deps.herdr = async () => ({ ok: false, out: "", reason: "unrecognized subcommand 'integration'" });
    expect(await keepReaderIntegrations(old.deps)).toEqual(["Could not check herdr's agent integrations: unrecognized subcommand 'integration'"]);

    const refused = fake(status({ claude: "not installed" }), { failInstall: true });
    expect((await keepReaderIntegrations(refused.deps)).join("\n")).toContain("Could not install herdr's Claude integration: permission denied");
    expect(existsSync(refused.deps.seenPath)).toBe(false);

    const lost = fake(status({ claude: "not installed" }), { installed: () => Promise.reject(new Error("no shell")) });
    expect(await keepReaderIntegrations(lost.deps)).toEqual([]);
    expect(lost.installs).toEqual([]);
  });
});

describe("the herdr command line", () => {
  test("gives herdr's output and first line of complaint, and never rejects", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shahi-herdr-cli-"));
    scratches.push(dir);
    const bin = join(dir, "herdr");
    writeFileSync(bin, '#!/bin/sh\nif [ "$2" = status ]; then echo "claude: current (v10) (/x)"; exit 0; fi\necho "error: unrecognized subcommand \'$2\'" >&2\necho "Usage: herdr" >&2\nexit 2\n');
    chmodSync(bin, 0o755);
    expect(await herdrCli(bin, ["integration", "status"])).toEqual({ ok: true, out: "claude: current (v10) (/x)\n", reason: "claude: current (v10) (/x)" });
    expect(await herdrCli(bin, ["integration", "bogus"])).toMatchObject({ ok: false, reason: "error: unrecognized subcommand 'bogus'" });
    expect((await herdrCli(join(dir, "missing"), ["integration", "status"])).ok).toBe(false);
  });
});
