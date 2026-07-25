import { describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgentPanelSort } from "./herdr-config";

const withConfig = async (toml: string, run: (path: string) => Promise<void>) => {
  const path = join(tmpdir(), `herdrui-cfg-${Math.random().toString(36).slice(2)}.toml`);
  await Bun.write(path, toml);
  try {
    await run(path);
  } finally {
    await unlink(path).catch(() => {});
  }
};

describe("readAgentPanelSort", () => {
  test("reads the real shape of a herdr config", async () => {
    await withConfig(
      ['onboarding = false', '[ui]', 'agent_panel_sort = "spaces"', '', '[ui.toast]', 'delivery = "terminal"'].join("\n"),
      async (path) => expect(await readAgentPanelSort(path)).toBe("space"),
    );
  });

  // herdr documents "workspaces" as an alias for "spaces".
  test("accepts the documented alias", async () => {
    await withConfig('[ui]\nagent_panel_sort = "workspaces"', async (path) =>
      expect(await readAgentPanelSort(path)).toBe("space"),
    );
  });

  test("reads priority", async () => {
    await withConfig('[ui]\nagent_panel_sort = "priority"', async (path) =>
      expect(await readAgentPanelSort(path)).toBe("priority"),
    );
  });

  // The key only counts under [ui]; the same name at top level is not it.
  test("ignores the key outside the ui table", async () => {
    await withConfig('agent_panel_sort = "priority"\n[other]\nx = 1', async (path) =>
      expect(await readAgentPanelSort(path)).toBeNull(),
    );
  });

  test("no preference stated", async () => {
    await withConfig('[ui]\nshow_agent_labels_on_pane_borders = false', async (path) =>
      expect(await readAgentPanelSort(path)).toBeNull(),
    );
  });

  // Soft failure throughout: this decides a default, not whether the app runs.
  test("survives a malformed config", async () => {
    await withConfig('[ui\nagent_panel_sort = ', async (path) =>
      expect(await readAgentPanelSort(path)).toBeNull(),
    );
  });

  test("survives a missing config", async () => {
    expect(await readAgentPanelSort("/definitely/not/here.toml")).toBeNull();
  });

  test("ignores a value herdr would not accept", async () => {
    await withConfig('[ui]\nagent_panel_sort = "sideways"', async (path) =>
      expect(await readAgentPanelSort(path)).toBeNull(),
    );
  });
});
