/**
 * Credentials stay on this phone, including the ones an earlier build saved.
 *
 * The fake keychain below behaves the way expo-secure-store does on iOS
 * (SecureStoreModule.swift): items are addressed by service and key, the
 * accessibility class is fixed when an item is added, and a later write to
 * the same item replaces its data only. That last rule is what makes this
 * worth testing: simply passing WHEN_UNLOCKED_THIS_DEVICE_ONLY on writes
 * would leave every existing credential in the class that backups carry to
 * another iPhone.
 */
const mockItems = new Map<string, { value: string; accessible: string }>();
const mockFailAdds = { on: false };
jest.mock("expo-secure-store", () => {
  const slot = (key: string, options?: { keychainService?: string }) => `${options?.keychainService ?? "app"}/${key}`;
  return {
    WHEN_UNLOCKED: "WHEN_UNLOCKED",
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: "WHEN_UNLOCKED_THIS_DEVICE_ONLY",
    getItemAsync: jest.fn(async (key: string, options?: { keychainService?: string }) => mockItems.get(slot(key, options))?.value ?? null),
    setItemAsync: jest.fn(async (key: string, value: string, options?: { keychainService?: string; keychainAccessible?: string }) => {
      const existing = mockItems.get(slot(key, options));
      if (existing) { existing.value = value; return; }
      if (mockFailAdds.on) throw new Error("errSecInteractionNotAllowed");
      mockItems.set(slot(key, options), { value, accessible: options?.keychainAccessible ?? "WHEN_UNLOCKED" });
    }),
    deleteItemAsync: jest.fn(async (key: string, options?: { keychainService?: string }) => { mockItems.delete(slot(key, options)); }),
  };
});

import { deleteSecret, readSecret, writeSecret } from "./keychain";

const everywhere = () => [...mockItems.entries()];
beforeEach(() => { mockItems.clear(); mockFailAdds.on = false; });

test("a credential saved by an earlier build moves to this-device-only storage on first read", async () => {
  mockItems.set("app/shahi.computers", { value: "[saved ssh login]", accessible: "WHEN_UNLOCKED" });

  await expect(readSecret("shahi.computers")).resolves.toBe("[saved ssh login]");

  expect(everywhere()).toEqual([["shahi.device-only/shahi.computers", { value: "[saved ssh login]", accessible: "WHEN_UNLOCKED_THIS_DEVICE_ONLY" }]]);
  await expect(readSecret("shahi.computers")).resolves.toBe("[saved ssh login]");
});

test("a move the keychain refuses keeps the original readable rather than losing it", async () => {
  mockItems.set("app/shahi.connection", { value: "[device secret]", accessible: "WHEN_UNLOCKED" });
  mockFailAdds.on = true;

  await expect(readSecret("shahi.connection")).resolves.toBe("[device secret]");
  expect(mockItems.get("app/shahi.connection")?.value).toBe("[device secret]");

  mockFailAdds.on = false;
  await expect(readSecret("shahi.connection")).resolves.toBe("[device secret]");
  expect(mockItems.get("shahi.device-only/shahi.connection")?.accessible).toBe("WHEN_UNLOCKED_THIS_DEVICE_ONLY");
  expect(mockItems.has("app/shahi.connection")).toBe(false);
});

test("new credentials are written this-device-only, and deleting removes every copy", async () => {
  await writeSecret("shahi.knownhost.box_22", "pin");
  expect(mockItems.get("shahi.device-only/shahi.knownhost.box_22")).toEqual({ value: "pin", accessible: "WHEN_UNLOCKED_THIS_DEVICE_ONLY" });

  mockItems.set("app/shahi.knownhost.box_22", { value: "old pin", accessible: "WHEN_UNLOCKED" });
  await deleteSecret("shahi.knownhost.box_22");
  expect(everywhere()).toEqual([]);
  await expect(readSecret("shahi.knownhost.box_22")).resolves.toBeNull();
});
