import { describe, expect, test } from "bun:test";
import { herdrCli, herdrSession } from "./herdr-session";

const home = "/home/me";

describe("herdrSession", () => {
  test("reads a named session and its config root from the socket path", () => {
    expect(herdrSession("/home/me/.config/herdr/sessions/qa/herdr.sock")).toEqual({ configRoot: "/home/me/.config", name: "qa" });
    expect(herdrSession("/home/me/.config/herdr/herdr.sock")).toEqual({ configRoot: "/home/me/.config", name: null });
    expect(herdrSession("/tmp/x.sock")).toBeNull();
  });
});

/**
 * Every hint the plugin printed said a bare `herdr`, which from an ordinary
 * shell reaches the default session: for someone running `herdr --session
 * qa`, `herdr plugin action invoke shahi.pair` failed with server_not_running,
 * and "run `herdr` to attach" started the default session, whose startup hook
 * took the service with it (pre-release bug hunt).
 */
describe("the herdr a hint tells someone to type", () => {
  test("names a named session, so hints typed outside its panes reach it", () => {
    expect(herdrCli("/home/me/.config/herdr/sessions/qa/herdr.sock", home)).toBe("herdr --session qa");
  });

  test("is plain herdr for the default session", () => {
    expect(herdrCli("/home/me/.config/herdr/herdr.sock", home)).toBe("herdr");
    expect(herdrCli(undefined, home)).toBe("herdr");
  });

  test("carries a config root other than ~/.config, which is where herdr looks a session up", () => {
    expect(herdrCli("/tmp/shahi-live.ab12/herdr/sessions/shahi-ci/herdr.sock", home)).toBe("XDG_CONFIG_HOME=/tmp/shahi-live.ab12 herdr --session shahi-ci");
    expect(herdrCli("/home/me/my config/herdr/herdr.sock", home)).toBe("XDG_CONFIG_HOME='/home/me/my config' herdr");
  });

  test("names the socket outright when herdr would never have chosen that path", () => {
    expect(herdrCli("/tmp/x.sock", home)).toBe("HERDR_SOCKET_PATH=/tmp/x.sock herdr");
  });
});
