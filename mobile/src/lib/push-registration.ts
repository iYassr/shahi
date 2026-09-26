import { deleteSecret, readSecret, writeSecret } from "./keychain";
import { sha256 } from "@noble/hashes/sha2.js";
import { api, type Api } from "./api";
import type { ComputerConnection } from "./computers";

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

/** Points registration at the selected computer, or at none. */
export function configurePushComputer(connection: ComputerConnection | null): void {
  const next = pushKeyFor(connection);
  if (next !== key) { key = next; revision++; }
}

export function preparePushRegistration(client: Api = api): (token: string) => Promise<void> {
  const savedKey = key;
  const current = revision;
  return async token => {
    registration = registration.catch(() => undefined).then(async () => {
      if (current !== revision) return;
      await client.registerPush(token);
      if (savedKey && current === revision) await writeSecret(savedKey, token);
    });
    await registration;
  };
}

export async function registerEnabledPush(token: string): Promise<void> {
  await preparePushRegistration()(token);
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
    registration = registration.catch(() => undefined).then(async () => {
      if (active() && current === revision) await client.registerPush(token);
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
    await client.registerPush(token);
    await client.unregisterPush(token);
    await deleteSecret(savedKey);
  });
  registration = run;
  await run;
}

/** Explicit logout waits for registration before asking the server to remove it. */
export async function forgetPushRegistration(): Promise<void> {
  const savedKey = key;
  revision++;
  await registration.catch(() => undefined);
  if (savedKey) await deleteSecret(savedKey).catch(() => undefined);
}

/** A prior reconnect may have failed to transfer the token's old session owner. */
export async function preparePushLogout(client: Api = api): Promise<void> {
  const current = revision;
  await restorePushRegistration(() => current === revision, client);
  if (current === revision) await forgetPushRegistration();
}
