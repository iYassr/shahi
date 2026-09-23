/**
 * Every Keychain item Shahi keeps, stored so that it stays on this phone.
 *
 * These items are the credentials themselves: a paired device's secret, an
 * SSH password or private key, the sidecar passcode, and the host keys this
 * phone has chosen to trust. expo-secure-store defaults to WHEN_UNLOCKED, and
 * iOS copies that class into encrypted and iCloud backups, so restoring a
 * backup onto another iPhone cloned this phone's device identity: two phones
 * the server cannot tell apart, where revoking one revokes both (pre-release
 * review). WHEN_UNLOCKED_THIS_DEVICE_ONLY has the same availability and is
 * never restored anywhere else.
 *
 * Passing the new class on a write is not enough on its own. expo-secure-store
 * updates an existing item's data and leaves its accessibility as it was, so
 * every item saved by an earlier build would keep travelling. Device-only
 * items therefore live in a keychain service of their own, and the first read
 * of a key found only in the default service moves it: copy, then delete the
 * original. Copying first means an interrupted move leaves a duplicate, never
 * a lost credential. Every key the app writes is read first (at launch, or
 * before a tunnel opens) except a push token, which grants nothing; deleting
 * removes both copies.
 */
import * as SecureStore from "expo-secure-store";

const DEVICE_ONLY: SecureStore.SecureStoreOptions = {
  keychainService: "shahi.device-only",
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

// One queue for every item: a move reads one service and writes the other,
// and a write landing in between would be overwritten by the older copy.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

export function readSecret(key: string): Promise<string | null> {
  return serial(async () => {
    const kept = await SecureStore.getItemAsync(key, DEVICE_ONLY);
    if (kept !== null) return kept;
    const earlier = await SecureStore.getItemAsync(key);
    if (earlier === null) return null;
    try {
      await SecureStore.setItemAsync(key, earlier, DEVICE_ONLY);
      await SecureStore.deleteItemAsync(key);
    } catch {
      // The original is still readable; the next read tries the move again.
    }
    return earlier;
  });
}

export function writeSecret(key: string, value: string): Promise<void> {
  return serial(() => SecureStore.setItemAsync(key, value, DEVICE_ONLY));
}

export function deleteSecret(key: string): Promise<void> {
  return serial(async () => {
    await SecureStore.deleteItemAsync(key, DEVICE_ONLY);
    await SecureStore.deleteItemAsync(key);
  });
}
