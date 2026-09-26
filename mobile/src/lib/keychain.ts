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
 * items therefore live in a keychain service of their own, and the default
 * service is something to drain: every read looks there too, and moves what
 * it finds (copy, then delete the original, so an interrupted move leaves a
 * duplicate, never a lost credential); every write deletes it; deleting
 * removes both copies. Every key the app writes is read first (at launch, or
 * before a tunnel opens) except a push token, which grants nothing.
 *
 * Draining on every read, not only when this build has no copy, is because an
 * earlier build can run again after this one: TestFlight installs an older
 * build over a newer one, and it reads and writes only the default service. A
 * computer paired there during a downgrade was missing after the return,
 * because this build read its own copy and never looked at the other, and its
 * device secret stayed in the class backups carry — to be adopted as this
 * phone's identity on the next restore (pre-release bug hunt).
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

/**
 * A key's value, with any copy an earlier build left in the default service
 * moved here.
 *
 * When both services hold the key, this build's copy wins, unless `merge`
 * combines them — the saved computers do, so one paired by an earlier build
 * is kept beside the rest.
 */
export function readSecret(key: string, merge?: (kept: string, earlier: string) => string): Promise<string | null> {
  return serial(async () => {
    const kept = await SecureStore.getItemAsync(key, DEVICE_ONLY);
    const earlier = await SecureStore.getItemAsync(key);
    if (earlier === null) return kept;
    const value = kept === null ? earlier : merge ? merge(kept, earlier) : kept;
    try {
      if (value !== kept) await SecureStore.setItemAsync(key, value, DEVICE_ONLY);
      await SecureStore.deleteItemAsync(key);
    } catch {
      // Both copies are still readable; the next read tries the move again.
    }
    return value;
  });
}

/**
 * Both copies of a key, moving nothing: for a value whose meaning depends on
 * which build saved it. A host key pinned by an earlier build was trusted
 * without being shown to anyone (see `lib/tunnel.ts`).
 */
export function readSecretCopies(key: string): Promise<{ kept: string | null; earlier: string | null }> {
  return serial(async () => ({
    kept: await SecureStore.getItemAsync(key, DEVICE_ONLY),
    earlier: await SecureStore.getItemAsync(key),
  }));
}

export function writeSecret(key: string, value: string): Promise<void> {
  return serial(async () => {
    await SecureStore.setItemAsync(key, value, DEVICE_ONLY);
    // A stale earlier copy is otherwise left in the class backups carry. If
    // this delete fails, the next read of the key tries again.
    await SecureStore.deleteItemAsync(key).catch(() => undefined);
  });
}

export function deleteSecret(key: string): Promise<void> {
  return serial(async () => {
    await SecureStore.deleteItemAsync(key, DEVICE_ONLY);
    await SecureStore.deleteItemAsync(key);
  });
}
