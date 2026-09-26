import * as SecureStore from "expo-secure-store";
import { api } from "./api";
import { configurePushComputer, forgetPushRegistration, preparePushLogout, pushKeyFor, registerEnabledPush, renewPushRegistration, restorePushRegistration, savedPushToken, unregisterPushRegistration } from "./push-registration";
import type { ComputerConnection } from "./computers";
import type { SshProfile } from "./ssh";
jest.mock("./api", () => ({ api: { registerPush: jest.fn(async () => {}), unregisterPush: jest.fn(async () => {}) } }));
const profile: SshProfile = { host: "box.test", username: "test", port: 22, remotePort: 7171, passcode: "fake", auth: { kind: "password", password: "fake" } };
const ssh = (p: SshProfile): ComputerConnection => ({ kind: "ssh", ssh: p });
const relay = (deviceId: string): ComputerConnection => ({ kind: "relay", relay: "https://relay.test", serverId: "box-id", deviceId, deviceSecret: "c2VjcmV0" });
/** This build's own keychain service; the default one an earlier build used is empty here. */
const values = new Map<string, string>();
beforeEach(() => {
  jest.clearAllMocks(); values.clear(); configurePushComputer(null);
  (SecureStore.getItemAsync as jest.Mock).mockImplementation(async (key, options) => (options?.keychainService ? values.get(key) ?? null : null));
  (SecureStore.setItemAsync as jest.Mock).mockImplementation(async (key, value, options) => { if (options?.keychainService) values.set(key, value); });
  (SecureStore.deleteItemAsync as jest.Mock).mockImplementation(async (key, options) => { if (options?.keychainService) values.delete(key); });
});
test("SSH opt-in survives new cookies but is scoped to the endpoint and removed on logout", async () => {
  configurePushComputer(ssh(profile));
  await registerEnabledPush("ExponentPushToken[stub]");
  await restorePushRegistration(() => true);
  expect(api.registerPush).toHaveBeenCalledTimes(2);
  configurePushComputer(ssh({ ...profile, remotePort: 8181 }));
  await restorePushRegistration(() => true);
  expect(api.registerPush).toHaveBeenCalledTimes(2);
  configurePushComputer(ssh(profile));
  await forgetPushRegistration();
  await restorePushRegistration(() => true);
  expect(api.registerPush).toHaveBeenCalledTimes(2);
  expect(values.size).toBe(0);
});
test("a cancelled reconnect does not register and logout waits for an in-flight registration", async () => {
  configurePushComputer(ssh(profile));
  await registerEnabledPush("ExponentPushToken[stub]");
  await restorePushRegistration(() => false);
  expect(api.registerPush).toHaveBeenCalledTimes(1);
  let release!: () => void;
  (api.registerPush as jest.Mock).mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
  const registering = restorePushRegistration(() => true);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  let cleared = false;
  const logout = forgetPushRegistration().then(() => { cleared = true; });
  await Promise.resolve();
  expect(cleared).toBe(false);
  release();
  await registering; await logout;
  expect(values.size).toBe(0);
});

test("logout retries a failed ownership transfer before clearing the saved opt-in", async () => {
  configurePushComputer(ssh(profile));
  await registerEnabledPush("ExponentPushToken[stub]");
  (api.registerPush as jest.Mock).mockRejectedValueOnce(new Error("network changed"));
  await restorePushRegistration(() => true);
  expect(values.size).toBe(1);
  await preparePushLogout();
  expect(api.registerPush).toHaveBeenCalledTimes(3);
  expect(values.size).toBe(0);
});

test("switching during logout cannot erase the next computer's notification opt-in", async () => {
  configurePushComputer(ssh({ ...profile, host: "second.test" }));
  await registerEnabledPush("ExponentPushToken[b]");
  configurePushComputer(ssh(profile));
  await registerEnabledPush("ExponentPushToken[a]");
  let release!: () => void;
  const client = { registerPush: jest.fn(() => new Promise<void>(r => { release = r; })) };
  const logout = preparePushLogout(client as never);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  configurePushComputer(ssh({ ...profile, host: "second.test" }));
  release();
  await logout;
  expect([...values.values()]).toContain("ExponentPushToken[b]");
  expect(client.registerPush).toHaveBeenCalledWith("ExponentPushToken[a]");
});

// An SSH opt-in saved before relay computers had keys lives where it did.
test("an SSH computer's saved opt-in is found under the key it was saved with", () => {
  const identity = JSON.stringify([profile.host, profile.port, profile.username, profile.remotePort]);
  const digest = require("@noble/hashes/sha2.js").sha256(new TextEncoder().encode(identity)) as Uint8Array;
  expect(pushKeyFor(ssh(profile))).toBe(`shahi.push.${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`);
});

// Pre-release bug hunt: a relay computer kept no record of the token it
// registered, so Settings read "Off" after every relaunch while its
// notifications kept arriving.
test("a relay computer remembers its opt-in, for the device this phone paired as", async () => {
  configurePushComputer(relay("d1"));
  await registerEnabledPush("ExponentPushToken[relay]");
  configurePushComputer(null);
  configurePushComputer(relay("d1"));
  expect(await savedPushToken()).toBe("ExponentPushToken[relay]");
  // Paired again: a new device, which has registered nothing.
  configurePushComputer(relay("d2"));
  expect(await savedPushToken()).toBeNull();
  configurePushComputer(ssh(profile));
  expect(await savedPushToken()).toBeNull();
});

test("turning notifications off tells the computer before the phone forgets the token", async () => {
  configurePushComputer(relay("d1"));
  await registerEnabledPush("ExponentPushToken[relay]");
  (api.unregisterPush as jest.Mock).mockRejectedValueOnce(new Error("offline"));
  await expect(unregisterPushRegistration()).rejects.toThrow("offline");
  expect(await savedPushToken()).toBe("ExponentPushToken[relay]");

  await unregisterPushRegistration();
  expect(api.unregisterPush).toHaveBeenLastCalledWith("ExponentPushToken[relay]");
  // Registered first, so a token an earlier SSH session still owns is the
  // asking session's to remove.
  expect((api.registerPush as jest.Mock).mock.invocationCallOrder.at(-1)).toBeLessThan((api.unregisterPush as jest.Mock).mock.invocationCallOrder.at(-1)!);
  expect(await savedPushToken()).toBeNull();
  expect(values.size).toBe(0);
});

// The server ends a passcode session's notifications when the session
// expires, and an SSH computer signs in afresh on every launch and reconnect.
test("an SSH computer's opt-in is carried to each new session; a relay device's needs no carrying", async () => {
  configurePushComputer(ssh(profile));
  await registerEnabledPush("ExponentPushToken[stub]");
  configurePushComputer(relay("d1"));
  await registerEnabledPush("ExponentPushToken[relay]");
  const client = { registerPush: jest.fn(async () => ({ ok: true })) };

  // Whichever computer is on screen: this one is in the background.
  await renewPushRegistration(ssh(profile), client as never, () => true);
  expect(client.registerPush).toHaveBeenCalledWith("ExponentPushToken[stub]");
  await renewPushRegistration(relay("d1"), client as never, () => true);
  await renewPushRegistration(ssh({ ...profile, host: "never-enabled.test" }), client as never, () => true);
  await renewPushRegistration(ssh(profile), client as never, () => false);
  expect(client.registerPush).toHaveBeenCalledTimes(1);

  client.registerPush.mockRejectedValueOnce(new Error("network changed"));
  await expect(renewPushRegistration(ssh(profile), client as never, () => true)).resolves.toBeUndefined();
});
