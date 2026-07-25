import { describe, expect, test } from "bun:test";
import { forgetInstalledAgents, installedAgents } from "./agents";

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
