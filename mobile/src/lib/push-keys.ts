/**
 * The keys that let this phone, and nothing in between, read a notification.
 *
 * A computer that offers `push-actions` seals what a waiting agent asks with
 * a key this phone gives it (`server/lib/push-seal.ts`); Expo and Apple carry
 * only the box. The Notification Service Extension opens it before iOS shows
 * the notification (`plugins/notification-service`), so the key has to be
 * where the extension can read it: a keychain access group the app and the
 * extension share, and nothing else is in. The app's own credentials stay in
 * its own group (`lib/keychain.ts`), out of the extension's reach.
 *
 * Readable after the first unlock rather than only while unlocked, because a
 * notification arrives on a locked phone, and kept on this device only, like
 * every other Shahi item. A key opens notifications and nothing more: it
 * cannot reach the computer.
 */
import { Buffer } from "buffer";
import Constants from "expo-constants";
import { getRandomBytes } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { sha256 } from "@noble/hashes/sha2.js";

export interface PushKey {
  /** base64 of 32 random bytes: what the computer seals with. */
  key: string;
  /** What a notification names its key by: the first 8 bytes of its SHA-256, in hex. */
  id: string;
}

/**
 * `<team>.<bundle>.push`, the group `plugins/with-notification-service.cjs`
 * entitles both targets to. Without a team id there is no shared group, and
 * the key stays where only the app can read it: notifications then show
 * their content-free words, which is the safe way to be wrong.
 */
function options(): SecureStore.SecureStoreOptions {
  const ios = Constants.expoConfig?.ios;
  return {
    keychainService: "shahi.push-keys",
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    ...(ios?.appleTeamId && ios.bundleIdentifier ? { accessGroup: `${ios.appleTeamId}.${ios.bundleIdentifier}.push` } : {}),
  };
}

/** The extension looks a key up by this name (`PushKeys` in NotificationService.swift). */
const nameOf = (id: string) => `shahi.push-key.${id}`;

export function newPushKey(): PushKey {
  const bytes = getRandomBytes(32);
  const id = Array.from(sha256(bytes).slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { key: Buffer.from(bytes).toString("base64"), id };
}

export async function storePushKey({ key, id }: PushKey): Promise<void> {
  await SecureStore.setItemAsync(nameOf(id), key, options());
}

export async function readPushKey(id: string): Promise<PushKey | null> {
  const key = await SecureStore.getItemAsync(nameOf(id), options());
  return key ? { key, id } : null;
}

export async function deletePushKey(id: string): Promise<void> {
  await SecureStore.deleteItemAsync(nameOf(id), options());
}
