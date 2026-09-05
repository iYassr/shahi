import * as SecureStore from "expo-secure-store";
import { sha256 } from "@noble/hashes/sha2.js";
import { api } from "./api";
import type { SshProfile } from "./ssh";

let key: string | null = null;
let revision = 0;
let registration: Promise<unknown> = Promise.resolve();

/** The SSH endpoint survives local port and login-cookie changes. */
export function configurePushProfile(profile: SshProfile | null): void {
  const identity = profile && JSON.stringify([profile.host.trim().toLowerCase(), profile.port, profile.username.trim(), profile.remotePort]);
  const next = identity ? `shahi.push.${Array.from(sha256(new TextEncoder().encode(identity)), (byte) => byte.toString(16).padStart(2, "0")).join("")}` : null;
  if (next !== key) { key = next; revision++; }
}

export async function registerEnabledPush(token: string): Promise<void> {
  const savedKey = key;
  const current = revision;
  registration = registration.catch(() => undefined).then(async () => {
    if (current !== revision) return;
    await api.registerPush(token);
    if (savedKey && current === revision) await SecureStore.setItemAsync(savedKey, token);
  });
  await registration;
}

/** Move the existing opt-in to the new session owner without prompting again. */
export async function restorePushRegistration(active: () => boolean): Promise<void> {
  const savedKey = key;
  const current = revision;
  if (!savedKey) return;
  try {
    const token = await SecureStore.getItemAsync(savedKey);
    if (!token || !active() || current !== revision) return;
    registration = registration.catch(() => undefined).then(async () => {
      if (active() && current === revision) await api.registerPush(token);
    });
    await registration;
  } catch {
    // A notification service failure must not prevent reconnecting the reader.
  }
}

/** Explicit logout waits for registration before asking the server to remove it. */
export async function forgetPushRegistration(): Promise<void> {
  const savedKey = key;
  revision++;
  await registration.catch(() => undefined);
  if (savedKey) await SecureStore.deleteItemAsync(savedKey).catch(() => undefined);
}

/** A prior reconnect may have failed to transfer the token's old session owner. */
export async function preparePushLogout(): Promise<void> {
  await restorePushRegistration(() => true);
  await forgetPushRegistration();
}
