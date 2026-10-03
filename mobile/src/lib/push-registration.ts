import { deleteSecret, readSecret, writeSecret } from "./keychain";
import { sha256 } from "@noble/hashes/sha2.js";
import { api, type Api } from "./api";
import type { ComputerConnection } from "./computers";
import { deletePushKey, readPushKey, storePushKey, type PushKey } from "./push-keys";

let key: string | null = null;
let revision = 0;
let registration: Promise<unknown> = Promise.resolve();

/**
 * Where this phone keeps the Expo token it registered with a computer.
 *
 * An SSH computer is named by its endpoint, which survives local port and
 * login-cookie changes. A relay computer is named by the device this phone
 * became when it paired, so pairing again starts from off: the new device has
 * registered nothing. Relay computers used to keep no record at all, and
 * Settings read "Off" after every relaunch while their notifications kept
 * arriving (pre-release bug hunt).
 */
export function pushKeyFor(connection: ComputerConnection | null): string | null {
  if (!connection) return null;
  const identity = connection.kind === "ssh"
    ? [connection.ssh.host.trim().toLowerCase(), connection.ssh.port, connection.ssh.username.trim(), connection.ssh.remotePort]
    : ["relay", connection.serverId, connection.deviceId];
  const digest = sha256(new TextEncoder().encode(JSON.stringify(identity)));
  return `shahi.push.${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Beside the token: the id of the push key this phone gave the computer for
 * sealed notifications (`lib/push-keys.ts`), when it gave one. The key itself
 * is in the group the notification extension reads; this says which one is
 * this computer's, so registering again sends it and turning off removes it.
 */
const keyIdFor = (savedKey: string) => `${savedKey}.sealed`;

async function savedSealKey(savedKey: string): Promise<PushKey | null> {
  const id = await readSecret(keyIdFor(savedKey));
  return id ? readPushKey(id) : null;
}

async function forgetSealKey(savedKey: string): Promise<void> {
  const id = await readSecret(keyIdFor(savedKey)).catch(() => null);
  if (id) await deletePushKey(id).catch(() => undefined);
  await deleteSecret(keyIdFor(savedKey));
}

/** A registration sends its key only when it has one: an older computer reads the body as it always did. */
const register = (client: Api, token: string, sealed: PushKey | null) =>
  sealed ? client.registerPush(token, sealed.key) : client.registerPush(token);

/** Points registration at the selected computer, or at none. */
export function configurePushComputer(connection: ComputerConnection | null): void {
  const next = pushKeyFor(connection);
  if (next !== key) { key = next; revision++; }
}

/**
 * Registers `token`, and `sealed` with it when the computer offers sealed
 * notifications. The key is stored before the computer hears of it, so the
 * first notification sealed with it can be opened; a registration that fails
 * takes its new key back out. A key the phone gave earlier is removed once
 * the computer has the new one.
 */
export function preparePushRegistration(client: Api = api): (token: string, sealed?: PushKey | null) => Promise<void> {
  const savedKey = key;
  const current = revision;
  return async (token, sealed = null) => {
    registration = registration.catch(() => undefined).then(async () => {
      if (current !== revision) return;
      const earlier = savedKey ? await readSecret(keyIdFor(savedKey)).catch(() => null) : null;
      if (sealed) await storePushKey(sealed);
      try {
        await register(client, token, sealed);
      } catch (e) {
        if (sealed) await deletePushKey(sealed.id).catch(() => undefined);
        throw e;
      }
      if (savedKey && current === revision) {
        await writeSecret(savedKey, token);
        if (sealed) await writeSecret(keyIdFor(savedKey), sealed.id);
        else await deleteSecret(keyIdFor(savedKey));
        if (earlier && earlier !== sealed?.id) await deletePushKey(earlier).catch(() => undefined);
      } else if (sealed) await deletePushKey(sealed.id).catch(() => undefined);
    });
    await registration;
  };
}

export async function registerEnabledPush(token: string, sealed: PushKey | null = null): Promise<void> {
  await preparePushRegistration()(token, sealed);
}

/** The token this phone registered with the selected computer, if it did. */
export async function savedPushToken(): Promise<string | null> {
  const savedKey = key;
  if (!savedKey) return null;
  return readSecret(savedKey).catch(() => null);
}

/** Move the existing opt-in to the new session owner without prompting again. */
export async function restorePushRegistration(active: () => boolean, client: Api = api): Promise<void> {
  const savedKey = key;
  const current = revision;
  if (!savedKey) return;
  try {
    const token = await readSecret(savedKey);
    if (!token || !active() || current !== revision) return;
    // Sent again with its key: a registration without one drops the key.
    const sealed = await savedSealKey(savedKey).catch(() => null);
    registration = registration.catch(() => undefined).then(async () => {
      if (active() && current === revision) await register(client, token, sealed);
    });
    await registration;
  } catch {
    // A notification service failure must not prevent reconnecting the reader.
  }
}

/**
 * Carries an SSH computer's opt-in over to the session it has just signed in
 * with, whichever computer is selected. The server ends a passcode session's
 * registrations when the session expires, and an SSH computer signs in afresh
 * on every launch; without this its notifications stopped once the session
 * that turned them on ran out. A relay computer's registration belongs to its
 * device, which does not expire.
 */
export async function renewPushRegistration(connection: ComputerConnection, client: Api, active: () => boolean): Promise<void> {
  const savedKey = pushKeyFor(connection);
  if (connection.kind !== "ssh" || !savedKey) return;
  const run = registration.catch(() => undefined).then(async () => {
    const token = await readSecret(savedKey);
    if (token && active()) await client.registerPush(token);
  });
  registration = run;
  // A notification service failure must not prevent reconnecting the reader.
  await run.catch(() => undefined);
}

/**
 * Turns the selected computer's notifications off on this phone.
 *
 * The server forgets the token before the phone does, so a failure leaves
 * Settings saying On, which is true, rather than Off while notifications keep
 * arriving. The token is registered again first because removal is scoped to
 * the session asking, and an SSH phone's token can still belong to an earlier
 * session if carrying it over failed.
 */
export async function unregisterPushRegistration(client: Api = api): Promise<void> {
  const savedKey = key;
  if (!savedKey) return;
  const run = registration.catch(() => undefined).then(async () => {
    const token = await readSecret(savedKey);
    if (!token) return;
    await register(client, token, await savedSealKey(savedKey).catch(() => null));
    await client.unregisterPush(token);
    await deleteSecret(savedKey);
    await forgetSealKey(savedKey);
  });
  registration = run;
  await run;
}

/** Explicit logout waits for registration before asking the server to remove it. */
export async function forgetPushRegistration(): Promise<void> {
  const savedKey = key;
  revision++;
  await registration.catch(() => undefined);
  if (savedKey) {
    await deleteSecret(savedKey).catch(() => undefined);
    await forgetSealKey(savedKey).catch(() => undefined);
  }
}

/** A prior reconnect may have failed to transfer the token's old session owner. */
export async function preparePushLogout(client: Api = api): Promise<void> {
  const current = revision;
  await restorePushRegistration(() => current === revision, client);
  if (current === revision) await forgetPushRegistration();
}
