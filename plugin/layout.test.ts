import { describe, expect, test } from "bun:test";
import { layoutFromEnv } from "./layout";

const injected = {
  HERDR_PLUGIN_ROOT: "/data/plugins/github/shahi",
  HERDR_PLUGIN_CONFIG_DIR: "/home/me/.config/herdr/plugins/shahi",
  HERDR_PLUGIN_STATE_DIR: "/home/me/.local/state/herdr/plugins/shahi",
  HERDR_SOCKET_PATH: "/home/me/.config/herdr/herdr.sock",
} as NodeJS.ProcessEnv;

describe("layoutFromEnv", () => {
  test("keeps nothing durable in the checkout", () => {
    // The root is a managed checkout that `herdr plugin install` replaces on
    // update; secrets and the database must live where that cannot reach.
    const layout = layoutFromEnv(injected);
    expect(layout.envFile).toBe("/home/me/.config/herdr/plugins/shahi/.env");
    expect(layout.dataPath).toBe("/home/me/.local/state/herdr/plugins/shahi/shahi.sqlite");
    expect(layout.logPath).toBe("/home/me/.local/state/herdr/plugins/shahi/shahi.log");
    expect(layout.webRoot).toBe("/data/plugins/github/shahi/web/dist");
    expect(layout.socketPath).toBe(injected.HERDR_SOCKET_PATH!);
    for (const durable of [layout.envFile, layout.dataPath, layout.logPath]) {
      expect(durable.startsWith(layout.root)).toBe(false);
    }
  });

  test("names what is missing, and how this is meant to be run", () => {
    expect(() => layoutFromEnv({} as NodeJS.ProcessEnv)).toThrow(
      /HERDR_PLUGIN_ROOT, HERDR_PLUGIN_CONFIG_DIR, HERDR_PLUGIN_STATE_DIR, HERDR_SOCKET_PATH not set.*herdr plugin action invoke/,
    );
    expect(() => layoutFromEnv({ ...injected, HERDR_SOCKET_PATH: "" })).toThrow(/^HERDR_SOCKET_PATH not set/);
  });
});
