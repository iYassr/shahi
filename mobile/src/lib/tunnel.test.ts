import type { SshProfile } from "./ssh";

/**
 * The tunnel's TypeScript face, with the native module faked.
 *
 * What lives here and not in Swift: the config handed to the native side,
 * which host key the login may go to, whose forward is whose, and the wording
 * when things fail. Each of those has a way to be quietly wrong — credentials
 * sent to an unchecked host, a reject with no message, one computer's tunnel
 * closed by another's — and none of them needs a real SSH server to prove.
 * The host-key review itself is proven in tunnel.pentest.test.ts.
 */

// `native` is captured when the module loads, so each test group loads a fresh
// copy after deciding whether the native module "exists". The factory reads
// the holder lazily, which is what makes that per-test choice possible.
type Native = { hostKey: jest.Mock; open: jest.Mock; close: jest.Mock };
let mockNative: Native | null = null;

jest.mock("expo", () => ({
  requireOptionalNativeModule: () => mockNative,
}));

type Tunnel = typeof import("./tunnel");
type Store = { getItemAsync: jest.Mock; setItemAsync: jest.Mock; deleteItemAsync: jest.Mock };

const KNOWN = "q3JLGlE4b0J7mV3r0e4oQnM0Qx1ZtVq2kS8i7uN5Yw0=";

function load(available = true): { tunnel: Tunnel; native: Native; store: Store } {
  mockNative = available
    ? {
        hostKey: jest.fn().mockResolvedValue({ hostKey: KNOWN, keyType: "ED25519" }),
        open: jest.fn().mockResolvedValue({ localPort: 45678, hostKey: KNOWN }),
        close: jest.fn().mockResolvedValue(undefined),
      }
    : null;
  jest.resetModules();
  // Re-required after the reset so these are the same instances tunnel.ts sees.
  const store = require("expo-secure-store") as Store;
  // A computer this phone has connected to before: its key is pinned.
  store.getItemAsync.mockImplementation(async (key: string) => (key.startsWith("shahi.knownhost.") ? KNOWN : null));
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

  test("a remembered key is passed down so the native side can refuse before authenticating", async () => {
    const { tunnel, native, store } = load();
    await tunnel.openTunnel(profile());
    expect(native.open.mock.calls[0]![0].expectedHostKey).toBe(KNOWN);
    // Not re-stored: overwriting the pin on every connect would turn
    // trust-on-first-use into trust-on-every-use.
    expect(store.setItemAsync).not.toHaveBeenCalled();
  });

  test("an unchanged key connects without asking again", async () => {
    const { tunnel, native } = load();
    const review = jest.fn();
    await tunnel.openTunnel(profile(), review);
    expect(native.hostKey).toHaveBeenCalledWith({ host: "box.example", port: 22 });
    expect(review).not.toHaveBeenCalled();
    expect(native.open.mock.calls[0]![0].expectedHostKey).toBe(KNOWN);
  });

  test("a native failure keeps its own words", async () => {
    const { tunnel, native } = load();
    native.open.mockRejectedValue(new Error("Host key for box.example has changed"));
    await expect(tunnel.openTunnel(profile())).rejects.toThrow("Host key for box.example has changed");
  });

  // A saved computer whose server was reinstalled: retrying cannot help, so
  // the refusal must reach the screen as itself, not as "reconnecting".
  test("a host key the native side refuses arrives as a HostKeyError in its own words", async () => {
    const { tunnel, native } = load();
    native.open.mockRejectedValue(Object.assign(
      new Error("ssh_host_key: This computer's host key has changed since you trusted it, so your login was not sent. (at SshTunnel/SshTunnelModule.swift:47)"),
      { code: "ssh_host_key" },
    ));
    const refused = await tunnel.openTunnel(profile()).catch((e: Error) => e);
    expect(refused).toBeInstanceOf(require("./errors").HostKeyError);
    expect((refused as Error).message).toBe("This computer's host key has changed since you trusted it, so your login was not sent.");
  });

  test("strips Expo's bridge envelope from a real native reason", async () => {
    const { tunnel, native } = load();
    native.open.mockRejectedValue(
      new Error("ssh_tunnel: Authentication failed (at ExpoModulesCore/Promise.swift:65)"),
    );
    await expect(tunnel.openTunnel(profile())).rejects.toThrow(/^Authentication failed$/);
  });

  // The regression behind "Never show 'undefined reason'": a native reject can
  // arrive with no message at all, and what the user saw was the word
  // "undefined". The replacement has to name the host and say what to check.
  test("a reasonless native failure becomes an actionable sentence, not 'undefined'", async () => {
    const { tunnel, native } = load();
    native.open.mockRejectedValue(new Error());
    await expect(tunnel.openTunnel(profile())).rejects.toThrow(/box\.example:22/);
  });

  test("Expo's wrapped 'undefined reason' becomes the same actionable sentence", async () => {
    const { tunnel, native } = load();
    native.hostKey.mockRejectedValue(
      new Error("ssh_tunnel: undefined reason (at ExpoModulesCore/Promise.swift:65)"),
    );
    await expect(tunnel.openTunnel(profile(), jest.fn())).rejects.toThrow(/box\.example:22/);
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
    await expect(withoutModule.tunnel.closeTunnel("")).resolves.toBeUndefined();

    const { tunnel, native } = load();
    await expect(tunnel.closeTunnel("http://127.0.0.1:1")).resolves.toBeUndefined();
    expect(native.close).not.toHaveBeenCalled();
    const url = await tunnel.openTunnel(profile());
    native.close.mockRejectedValue(new Error("already dead"));
    await expect(tunnel.closeTunnel(url)).resolves.toBeUndefined();
  });
});

// Modelled on SshTunnelModule.swift, which closes any forward already open
// under the id it is asked to open. Ids used to be derived from the computer,
// so re-adding a saved computer replaced the saved forward, and disposing the
// old session then closed the new one; a failed re-add closed the saved one.
test("a second tunnel to the same computer neither replaces the first nor is closed with it", async () => {
  const { tunnel, native } = load();
  const live = new Map<string, number>();
  let port = 50000;
  native.open.mockImplementation(async ({ id }: { id: string }) => {
    live.delete(id);
    live.set(id, ++port);
    return { localPort: port };
  });
  native.close.mockImplementation(async (id: string) => { live.delete(id); });

  const saved = await tunnel.openTunnel(profile());
  const readd = await tunnel.openTunnel(profile());
  expect(readd).not.toBe(saved);
  expect(live.size).toBe(2);

  await tunnel.closeTunnel(readd);
  expect([...live.values()]).toEqual([Number(saved.split(":").at(-1))]);
  await tunnel.closeTunnel(saved);
  expect(live.size).toBe(0);
});

describe("forgetHostKey", () => {
  test("removing the last login to a host:port forgets its key; another login to it keeps the key", async () => {
    const { tunnel, store } = load();
    await tunnel.forgetHostKey(profile({ username: "a" }), [profile({ host: "BOX.example ", username: "b" })]);
    expect(store.deleteItemAsync).not.toHaveBeenCalled();

    await tunnel.forgetHostKey(profile({ username: "a" }), [profile({ port: 2222 })]);
    expect(store.deleteItemAsync).toHaveBeenCalledWith("shahi.knownhost.box.example_22", expect.anything());
    expect(store.deleteItemAsync).toHaveBeenCalledWith("shahi.knownhost.box.example_22");
  });
});
