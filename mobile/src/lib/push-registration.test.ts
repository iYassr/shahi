import * as SecureStore from "expo-secure-store";
import { api } from "./api";
import { configurePushProfile, forgetPushRegistration, preparePushLogout, registerEnabledPush, restorePushRegistration } from "./push-registration";
import type { SshProfile } from "./ssh";
jest.mock("./api", () => ({ api: { registerPush: jest.fn(async () => {}) } }));
const profile: SshProfile = { host: "box.test", username: "test", port: 22, remotePort: 7171, passcode: "fake", auth: { kind: "password", password: "fake" } };
const values = new Map<string, string>();
beforeEach(() => {
  jest.clearAllMocks(); values.clear(); configurePushProfile(null);
  (SecureStore.getItemAsync as jest.Mock).mockImplementation(async (key) => values.get(key) ?? null);
  (SecureStore.setItemAsync as jest.Mock).mockImplementation(async (key, value) => { values.set(key, value); });
  (SecureStore.deleteItemAsync as jest.Mock).mockImplementation(async (key) => { values.delete(key); });
});
test("SSH opt-in survives new cookies but is scoped to the endpoint and removed on logout", async () => {
  configurePushProfile(profile);
  await registerEnabledPush("ExponentPushToken[stub]");
  await restorePushRegistration(() => true);
  expect(api.registerPush).toHaveBeenCalledTimes(2);
  configurePushProfile({ ...profile, remotePort: 8181 });
  await restorePushRegistration(() => true);
  expect(api.registerPush).toHaveBeenCalledTimes(2);
  configurePushProfile(profile);
  await forgetPushRegistration();
  await restorePushRegistration(() => true);
  expect(api.registerPush).toHaveBeenCalledTimes(2);
  expect(values.size).toBe(0);
});
test("a cancelled reconnect does not register and logout waits for an in-flight registration", async () => {
  configurePushProfile(profile);
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
  configurePushProfile(profile);
  await registerEnabledPush("ExponentPushToken[stub]");
  (api.registerPush as jest.Mock).mockRejectedValueOnce(new Error("network changed"));
  await restorePushRegistration(() => true);
  expect(values.size).toBe(1);
  await preparePushLogout();
  expect(api.registerPush).toHaveBeenCalledTimes(3);
  expect(values.size).toBe(0);
});
