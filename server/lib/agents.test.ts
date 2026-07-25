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
    const agents = await installedAgents(["bash; touch /tmp/herdrui-pwned", "$(id)", "a b"]);
    expect(agents).toEqual([]);
    expect(await Bun.file("/tmp/herdrui-pwned").exists()).toBe(false);
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
