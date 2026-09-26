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
const mockFailDeletes = { left: 0 };
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
    deleteItemAsync: jest.fn(async (key: string, options?: { keychainService?: string }) => {
      if (mockFailDeletes.left > 0) { mockFailDeletes.left--; throw new Error("errSecInteractionNotAllowed"); }
      mockItems.delete(slot(key, options));
    }),
  };
});

import { deleteSecret, readSecret, readSecretCopies, writeSecret } from "./keychain";
import { mergeSavedComputers, type SavedComputer } from "./computers";

const everywhere = () => [...mockItems.entries()];
beforeEach(() => { mockItems.clear(); mockFailAdds.on = false; mockFailDeletes.left = 0; });

/** A saved relay computer, as both builds write them. */
function computer(name: string): SavedComputer {
  return { id: `id-${name}`, name, pins: [], connection: { kind: "relay", relay: "https://relay.getshahi.dev", serverId: `server-${name}`, deviceId: `device-${name}`, deviceSecret: `secret-${name}` } };
}

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

// TestFlight installs an older build over a newer one. That build reads and
// writes only the default service: a computer it paired was missing when this
// build returned, and its device secret stayed where backups carry it, to be
// adopted as this phone's identity on the next restore (pre-release bug hunt).
test("a computer an earlier build paired after a downgrade is kept, and its secret leaves the backed-up service", async () => {
  mockItems.set("shahi.device-only/shahi.computers", { value: JSON.stringify([computer("a")]), accessible: "WHEN_UNLOCKED_THIS_DEVICE_ONLY" });
  mockItems.set("app/shahi.computers", { value: JSON.stringify([computer("b")]), accessible: "WHEN_UNLOCKED" });

  const saved = JSON.parse((await readSecret("shahi.computers", mergeSavedComputers))!) as SavedComputer[];

  expect(saved.map(c => c.name)).toEqual(["a", "b"]);
  expect(everywhere()).toEqual([["shahi.device-only/shahi.computers", { value: JSON.stringify(saved), accessible: "WHEN_UNLOCKED_THIS_DEVICE_ONLY" }]]);
});

test("this build's saved computer wins over an earlier build's copy of the same one", async () => {
  const ours = computer("a");
  mockItems.set("shahi.device-only/shahi.computers", { value: JSON.stringify([ours]), accessible: "WHEN_UNLOCKED_THIS_DEVICE_ONLY" });
  mockItems.set("app/shahi.computers", { value: JSON.stringify([{ ...ours, name: "older" }]), accessible: "WHEN_UNLOCKED" });
  expect(JSON.parse((await readSecret("shahi.computers", mergeSavedComputers))!)).toEqual([ours]);
  expect(mockItems.has("app/shahi.computers")).toBe(false);
});

test("an earlier build's copy beside this build's own is drained, and this build's value is kept", async () => {
  mockItems.set("shahi.device-only/shahi.connection", { value: "[this build's]", accessible: "WHEN_UNLOCKED_THIS_DEVICE_ONLY" });
  mockItems.set("app/shahi.connection", { value: "[earlier build's]", accessible: "WHEN_UNLOCKED" });
  await expect(readSecret("shahi.connection")).resolves.toBe("[this build's]");
  expect(everywhere()).toEqual([["shahi.device-only/shahi.connection", { value: "[this build's]", accessible: "WHEN_UNLOCKED_THIS_DEVICE_ONLY" }]]);
});

// The move copied, and the delete of the original failed: the old code never
// looked at the default service again once its own copy existed.
test("a delete that fails while moving a credential is tried again on the next read", async () => {
  mockItems.set("app/shahi.connection", { value: "[device secret]", accessible: "WHEN_UNLOCKED" });
  mockFailDeletes.left = 1;
  await expect(readSecret("shahi.connection")).resolves.toBe("[device secret]");
  expect(mockItems.has("app/shahi.connection")).toBe(true);

  await expect(readSecret("shahi.connection")).resolves.toBe("[device secret]");
  expect(everywhere()).toEqual([["shahi.device-only/shahi.connection", { value: "[device secret]", accessible: "WHEN_UNLOCKED_THIS_DEVICE_ONLY" }]]);
});

test("writing a credential removes an earlier build's stale copy of it", async () => {
  mockItems.set("app/shahi.connection", { value: "[stale]", accessible: "WHEN_UNLOCKED" });
  await writeSecret("shahi.connection", "[current]");
  expect(everywhere()).toEqual([["shahi.device-only/shahi.connection", { value: "[current]", accessible: "WHEN_UNLOCKED_THIS_DEVICE_ONLY" }]]);
});

test("reading both copies of a key moves neither", async () => {
  mockItems.set("app/shahi.knownhost.box_22", { value: "unseen pin", accessible: "WHEN_UNLOCKED" });
  await expect(readSecretCopies("shahi.knownhost.box_22")).resolves.toEqual({ kept: null, earlier: "unseen pin" });
  expect(everywhere()).toEqual([["app/shahi.knownhost.box_22", { value: "unseen pin", accessible: "WHEN_UNLOCKED" }]]);
});
