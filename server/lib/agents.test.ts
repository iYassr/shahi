import { modesFor } from "@shahi/shared";
import { describe, expect, test } from "bun:test";
import { forgetInstalledAgents, installedAgents, startAgentInTab } from "./agents";

describe("installedAgents", () => {
  test("resolves through a login shell, not this process's PATH", async () => {
    forgetInstalledAgents();
    // `bash` itself is always present and always on a login shell's PATH.
    const agents = await installedAgents(["bash"]);
    expect(agents.map((a) => a.kind)).toEqual(["bash"]);
    expect(agents[0]!.command).toMatch(/\/bash$/);
  });

  test("omits kinds that are not installed", async () => {
    forgetInstalledAgents();
    const agents = await installedAgents(["bash", "definitely-not-installed-9f3a"]);
    expect(agents.map((a) => a.kind)).toEqual(["bash"]);
  });

  // Kind names come from herdr, but they are interpolated into a shell command,
  // so anything shell-special must never reach it.
  test("drops names that are not plain identifiers", async () => {
    forgetInstalledAgents();
    const agents = await installedAgents(["bash; touch /tmp/shahi-pwned", "$(id)", "a b"]);
    expect(agents).toEqual([]);
    expect(await Bun.file("/tmp/shahi-pwned").exists()).toBe(false);
  });

  test("returns nothing for an empty list", async () => {
    forgetInstalledAgents();
    expect(await installedAgents([])).toEqual([]);
  });

  test("caches, and forgets on demand", async () => {
    forgetInstalledAgents();
    const first = await installedAgents(["bash"]);
    // A different question inside the TTL returns the cached answer.
    expect(await installedAgents(["definitely-not-installed-9f3a"])).toEqual(first);

    forgetInstalledAgents();
    expect(await installedAgents(["definitely-not-installed-9f3a"])).toEqual([]);
  });

  test("expires the cache after the TTL", async () => {
    forgetInstalledAgents();
    let clock = 0;
    const now = () => clock;
    await installedAgents(["bash"], now);
    clock = 61_000;
    expect(await installedAgents(["definitely-not-installed-9f3a"], now)).toEqual([]);
  });

  test("sorts by kind", async () => {
    forgetInstalledAgents();
    const agents = await installedAgents(["bash", "ls", "env"]);
    expect(agents.map((a) => a.kind)).toEqual([...agents.map((a) => a.kind)].sort());
  });
});

describe("startAgentInTab", () => {
  const options = {
    workspaceId: "w1",
    cwd: "/home/u/project",
    label: null,
    kind: "codex",
    name: "codex",
  };

  for (const kind of ["pi", "claude", "codex", "gemini", "cursor", "devin", "agy", "cline", "omp", "mastracode", "opencode", "copilot", "kimi", "kiro", "droid", "amp", "grok", "hermes", "kilo", "qodercli", "qwen", "letta", "maki", "muse"]) {
    for (const mode of modesFor(kind).length ? modesFor(kind) : [null]) {
      test(`${kind}/${mode?.id ?? "default"} always starts in a fresh pane with only its selected permissions`, async () => {
        let tabs = 0;
        const starts: Record<string, unknown>[] = [];
        const rpc = async (method: string, params: unknown) => {
          if (method === "tab.create") return { root_pane: { pane_id: `w1:p${++tabs}` } } as never;
          starts.push(params as Record<string, unknown>);
          return {} as never;
        };
        const input = { ...options, kind, mode: mode?.id };
        const first = await startAgentInTab(rpc, input);
        const second = await startAgentInTab(rpc, input);
        expect(first.paneId).not.toBe(second.paneId);
        expect(starts).toEqual([first, second].map(({ paneId }) => ({
          pane_id: paneId, kind, name: "codex", ...(mode?.args.length ? { args: mode.args } : {}),
        })));
      });
    }
  }

  test("human names retain their label while using safe internal identifiers", async () => {
    for (const label of ["Customer cursor review", "123 project", "مراجعة العمل", "Café notes", "A".repeat(100)]) {
      const calls: { method: string; params: Record<string, unknown> }[] = [];
      const rpc = async (method: string, params: unknown) => {
        calls.push({ method, params: params as Record<string, unknown> });
        return { root_pane: { pane_id: "w1:p2" } } as never;
      };
      await startAgentInTab(rpc, { ...options, kind: "cursor", name: label, label });
      expect(calls[0]!.params.label).toBe(label);
      expect(calls[1]!.params.name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    }
  });

  test("returns the pane the tab was created with", async () => {
    const calls: string[] = [];
    const rpc = async (method: string) => {
      calls.push(method);
      return { root_pane: { pane_id: "w1:p2" }, tab: { tab_id: "w1:t2" } } as never;
    };
    expect(await startAgentInTab(rpc, options, async () => {})).toEqual({
      paneId: "w1:p2",
      tabId: "w1:t2",
    });
    expect(calls).toEqual(["tab.create", "agent.start"]);
  });

  test("a second default-named agent retries in its own pane with a unique control name", async () => {
    let tabs = 0;
    const names = new Set<string>();
    const starts: { pane_id: string; name: string }[] = [];
    const rpc = async (method: string, params: unknown) => {
      if (method === "tab.create") return { root_pane: { pane_id: `w1:p${++tabs}` } } as never;
      const start = params as { pane_id: string; name: string };
      starts.push(start);
      if (names.has(start.name)) throw new Error("herdr agent.start failed [agent_name_taken]");
      names.add(start.name);
      return {} as never;
    };
    const [first, second] = await Promise.all([startAgentInTab(rpc, options), startAgentInTab(rpc, options)]);
    expect(first.paneId).not.toBe(second.paneId);
    expect(tabs).toBe(2);
    expect(names.size).toBe(2);
    expect(starts[2]?.pane_id).toBe(second.paneId);
    expect(starts[2]?.name).toMatch(/^codex-[0-9a-f]{8}$/);
  });

  test("a mode reaches agent.start as the resolved flags", async () => {
    // The route dropped `mode` on the floor for months and every agent
    // started with default permissions — the picker was decorative. Found by
    // ps on a live box showing bare `claude` after "Plan first" was chosen.
    // This pins the half of the chain that lives in this file.
    let startParams: Record<string, unknown> | undefined;
    const rpc = async (method: string, params: unknown) => {
      if (method === "tab.create") return { root_pane: { pane_id: "w1:p2" } } as never;
      startParams = params as Record<string, unknown>;
      return {} as never;
    };
    await startAgentInTab(rpc, { ...options, kind: "claude", name: "c", mode: "plan" }, async () => {});
    expect(startParams?.args).toEqual(["--permission-mode", "plan"]);
  });

  test("no mode means no args key at all", async () => {
    let startParams: Record<string, unknown> | undefined;
    const rpc = async (method: string, params: unknown) => {
      if (method === "tab.create") return { root_pane: { pane_id: "w1:p2" } } as never;
      startParams = params as Record<string, unknown>;
      return {} as never;
    };
    await startAgentInTab(rpc, options, async () => {});
    expect("args" in (startParams ?? {})).toBe(false);
  });

  test("retries while the pane is still becoming a shell", async () => {
    let starts = 0;
    const rpc = async (method: string) => {
      if (method === "tab.create") return { root_pane: { pane_id: "w1:p2" } } as never;
      if (++starts < 3) throw new Error("herdr agent.start failed [agent_pane_busy]: not a shell");
      return {} as never;
    };
    const waits: number[] = [];
    await startAgentInTab(rpc, options, async (ms) => void waits.push(ms));
    expect(starts).toBe(3);
    expect(waits).toHaveLength(2);
  });

  test("gives up rather than retrying forever", async () => {
    const rpc = async (method: string) => {
      if (method === "tab.create") return { root_pane: { pane_id: "w1:p2" } } as never;
      throw new Error("herdr agent.start failed [agent_pane_busy]: not a shell");
    };
    expect(startAgentInTab(rpc, options, async () => {})).rejects.toThrow("agent_pane_busy");
  });

  test("does not retry a real failure", async () => {
    let starts = 0;
    const rpc = async (method: string) => {
      if (method === "tab.create") return { root_pane: { pane_id: "w1:p2" } } as never;
      starts++;
      throw new Error("herdr agent.start failed [unknown_agent]: no such kind");
    };
    expect(startAgentInTab(rpc, options, async () => {})).rejects.toThrow("unknown_agent");
    expect(starts).toBe(1);
  });

  test("refuses to guess when herdr does not name the pane", async () => {
    const rpc = async () => ({}) as never;
    expect(startAgentInTab(rpc, options, async () => {})).rejects.toThrow("without telling us");
  });
});

test("a launch acknowledgment waits for the new agent's composer without creating another pane", async () => {
  const calls: string[] = [];
  let checks = 0;
  const rpc = async (method: string) => {
    calls.push(method);
    if (method === "tab.create") return { root_pane: { pane_id: "new" } } as never;
    if (method === "agent.start") return { agent: { interactive_ready: false, launch_pending: true } } as never;
    return { agent: { interactive_ready: ++checks === 2, launch_pending: checks < 2 } } as never;
  };
  const result = await startAgentInTab(rpc, { workspaceId: "w", cwd: null, label: null, kind: "cursor", name: "cursor" }, async () => {});
  expect(result.paneId).toBe("new");
  expect(calls).toEqual(["tab.create", "agent.start", "agent.get", "agent.get"]);
});

test("a startup that never becomes ready is bounded and is never relaunched", async () => {
  let starts = 0, checks = 0;
  const rpc = async (method: string) => {
    if (method === "tab.create") return { root_pane: { pane_id: "new" } } as never;
    if (method === "agent.start") starts++; else checks++;
    return { agent: { interactive_ready: false, launch_pending: true } } as never;
  };
  await expect(startAgentInTab(rpc, { workspaceId: "w", cwd: null, label: null, kind: "codex", name: "codex" }, async () => {})).rejects.toThrow("still starting");
  expect(starts).toBe(1);
  expect(checks).toBe(600);
});

test("a startup permission question opens immediately instead of waiting for an answer behind the sheet", async () => {
  const calls: string[] = [];
  const rpc = async (method: string) => {
    calls.push(method);
    if (method === "tab.create") return { root_pane: { pane_id: "new" } } as never;
    return { agent: { interactive_ready: false, launch_pending: true, agent_status: "blocked" } } as never;
  };
  expect((await startAgentInTab(rpc, { workspaceId: "w", cwd: null, label: null, kind: "claude", name: "claude" }, async () => {})).paneId).toBe("new");
  expect(calls).toEqual(["tab.create", "agent.start"]);
});
