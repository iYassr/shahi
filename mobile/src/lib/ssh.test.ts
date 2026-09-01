import { DEFAULT_SIDECAR_PORT, DEFAULT_SSH_PORT, emptySshProfile, sshProfileReady } from "./ssh";

/**
 * The gate on the Connect button. Too strict and a valid profile cannot
 * connect; too loose and the native module is asked to open a session with a
 * blank host, and its error is worse than the form just staying disabled.
 */
describe("sshProfileReady", () => {
  test("a fresh form is not ready, and carries the standard ports", () => {
    const p = emptySshProfile();
    expect(sshProfileReady(p)).toBe(false);
    expect(p.port).toBe(DEFAULT_SSH_PORT);
    expect(p.remotePort).toBe(DEFAULT_SIDECAR_PORT);
  });

  const filled = () => ({
    ...emptySshProfile(),
    host: "box.example",
    username: "y",
    passcode: "1234",
    auth: { kind: "password" as const, password: "hunter2" },
  });

  test("host, username, passcode and a password make it ready", () => {
    expect(sshProfileReady(filled())).toBe(true);
  });

  // Whitespace is what a phone keyboard's autocomplete leaves behind; a
  // host of spaces must not enable the button.
  test("a whitespace-only host or username does not count as filled", () => {
    expect(sshProfileReady({ ...filled(), host: "   " })).toBe(false);
    expect(sshProfileReady({ ...filled(), username: "\n" })).toBe(false);
  });

  test("the sidecar passcode is required — the tunnel alone signs nothing in", () => {
    expect(sshProfileReady({ ...filled(), passcode: "" })).toBe(false);
  });

  test("key auth needs the key, but an empty passphrase is a valid unencrypted key", () => {
    const withKey = (privateKey: string) => ({
      ...filled(),
      auth: { kind: "key" as const, privateKey, passphrase: "" },
    });
    expect(sshProfileReady(withKey(""))).toBe(false);
    expect(sshProfileReady(withKey("  \n"))).toBe(false);
    expect(sshProfileReady(withKey("-----BEGIN OPENSSH PRIVATE KEY-----\n…"))).toBe(true);
  });

  test("an empty password is not a credential", () => {
    expect(sshProfileReady({ ...filled(), auth: { kind: "password", password: "" } })).toBe(false);
  });
});
