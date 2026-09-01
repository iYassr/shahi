import type { SshProfile } from "./ssh";

/**
 * The tunnel's TypeScript face, with the native module faked.
 *
 * What lives here and not in Swift: the config handed to the native side,
 * trust-on-first-use for host keys, and the wording when things fail. Each of
 * those has a way to be quietly wrong — credentials sent to a changed host,
 * a reject with no message — and none of them needs a real SSH server to prove.
 */

// `native` is captured when the module loads, so each test group loads a fresh
// copy after deciding whether the native module "exists". The factory reads
// the holder lazily, which is what makes that per-test choice possible.
let mockNative: { open: jest.Mock; close: jest.Mock } | null = null;

jest.mock("expo", () => ({
  requireOptionalNativeModule: () => mockNative,
}));

type Tunnel = typeof import("./tunnel");
type Store = { getItemAsync: jest.Mock; setItemAsync: jest.Mock };

function load(available = true): { tunnel: Tunnel; native: { open: jest.Mock; close: jest.Mock }; store: Store } {
  mockNative = available
    ? {
        open: jest.fn().mockResolvedValue({ localPort: 45678, hostKey: "SHA256:first" }),
        close: jest.fn().mockResolvedValue(undefined),
      }
    : null;
  jest.resetModules();
  // Re-required after the reset so these are the same instances tunnel.ts sees.
  const store = require("expo-secure-store") as Store;
  const tunnel = require("./tunnel") as Tunnel;
  return { tunnel, native: mockNative!, store };
}

const profile = (over: Partial<SshProfile> = {}): SshProfile => ({
  host: "box.example",
  port: 22,
  username: "y",
  auth: { kind: "password", password: "hunter2" },
  remotePort: 7171,
  passcode: "1234",
  ...over,
});

describe("openTunnel", () => {
  test("hands back a loopback base URL on the forwarded port", async () => {
    const { tunnel } = load();
    await expect(tunnel.openTunnel(profile())).resolves.toBe("http://127.0.0.1:45678");
  });

  // The forward targets localhost *on the box*: the sidecar binds loopback and
  // the SSH session is already there. Pointing it at the public host instead
  // would only work on boxes that expose the port — the case SSH exists to avoid.
  test("forwards to 127.0.0.1 on the far side, with trimmed host and username", async () => {
    const { tunnel, native } = load();
    await tunnel.openTunnel(profile({ host: " box.example ", username: " y " }));
    expect(native.open).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "box.example",
        username: "y",
        remoteHost: "127.0.0.1",
        remotePort: 7171,
        password: "hunter2",
      }),
    );
  });

  test("key auth sends the key and passphrase, never a password field", async () => {
    const { tunnel, native } = load();
    await tunnel.openTunnel(
      profile({ auth: { kind: "key", privateKey: "-----BEGIN…", passphrase: "pp" } }),
    );
    const config = native.open.mock.calls[0]![0];
    expect(config.privateKey).toBe("-----BEGIN…");
    expect(config.passphrase).toBe("pp");
    expect(config).not.toHaveProperty("password");
  });

  test("first contact: no expectedHostKey goes down, the reported key is remembered", async () => {
    const { tunnel, native, store } = load();
    await tunnel.openTunnel(profile());
    expect(native.open.mock.calls[0]![0]).not.toHaveProperty("expectedHostKey");
    expect(store.setItemAsync).toHaveBeenCalledWith(expect.stringContaining("knownhost"), "SHA256:first");
  });

  test("a remembered key is passed down so the native side can refuse before authenticating", async () => {
    const { tunnel, native, store } = load();
    store.getItemAsync.mockResolvedValue("SHA256:known");
    await tunnel.openTunnel(profile());
    expect(native.open.mock.calls[0]![0].expectedHostKey).toBe("SHA256:known");
    // Not re-stored: overwriting the pin on every connect would turn
    // trust-on-first-use into trust-on-every-use.
    expect(store.setItemAsync).not.toHaveBeenCalled();
  });

  test("a native failure keeps its own words", async () => {
    const { tunnel, native } = load();
    native.open.mockRejectedValue(new Error("Host key for box.example has changed"));
    await expect(tunnel.openTunnel(profile())).rejects.toThrow("Host key for box.example has changed");
  });

  // The regression behind "Never show 'undefined reason'": a native reject can
  // arrive with no message at all, and what the user saw was the word
  // "undefined". The replacement has to name the host and say what to check.
  test("a reasonless native failure becomes an actionable sentence, not 'undefined'", async () => {
    const { tunnel, native } = load();
    native.open.mockRejectedValue(new Error());
    await expect(tunnel.openTunnel(profile())).rejects.toThrow(/box\.example:22/);
  });

  test("a build without the native module says so instead of undefined-is-not-a-function", async () => {
    const { tunnel } = load(false);
    expect(tunnel.sshTunnelAvailable()).toBe(false);
    await expect(tunnel.openTunnel(profile())).rejects.toThrow(/rebuild the app/i);
  });
});

describe("closeTunnel", () => {
  test("is safe when nothing is open and when the native close rejects", async () => {
    const withoutModule = load(false);
    await expect(withoutModule.tunnel.closeTunnel()).resolves.toBeUndefined();

    const { tunnel, native } = load();
    native.close.mockRejectedValue(new Error("already dead"));
    await expect(tunnel.closeTunnel()).resolves.toBeUndefined();
  });
});
