import { describe, expect, test } from "bun:test";
import { layoutFromEnv } from "./layout";
import { DEFAULT_RELAY_URL, lingerHint, relayUrlFor, serviceSpec } from "./shahi";

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
