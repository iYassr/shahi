/**
 * Native push: a phone that taps you on the shoulder when an agent is waiting.
 *
 * The web client does this with Web Push and a service worker. A native app has
 * neither, so it registers an Expo push token instead and the server sends the
 * same notification over both channels.
 *
 * Two conditions have to hold, and both are reported rather than swallowed:
 *
 *  - A real device. Emulators and simulators have no push transport.
 *  - A development or production build. Expo Go dropped remote push in SDK 53.
 *
 * That second one is why `expo-notifications` is imported lazily. In Expo Go the
 * module throws as it loads, and a static import at the top of this file takes
 * the whole app down with it — the dashboard, the reader, everything — over a
 * feature that is not even in use yet. Loading it at the moment someone asks for
 * notifications turns that crash into a sentence.
 */
import * as Device from "expo-device";
import Constants, { ExecutionEnvironment } from "expo-constants";
import { preparePushRegistration, savedPushToken } from "@/lib/push-registration";

import { api, type Api } from "./api";

type Notifications = typeof import("expo-notifications");

export type PushResult = { ok: true; token: string } | { ok: false; reason: string };

const EXPO_GO_NOTE =
  "Expo Go cannot receive push notifications since SDK 53. A development build can.";

/**
 * Whether this build can load `expo-notifications` at all.
 *
 * Asked before importing rather than after: inside Expo Go the module throws as
 * it evaluates, and that throw does not reliably arrive somewhere catchable — it
 * surfaces as an uncaught error and takes the app down. Checking first is the
 * only version of this that stays quiet.
 */
const canLoad = Constants.executionEnvironment !== ExecutionEnvironment.StoreClient;

async function load(): Promise<Notifications | null> {
  if (!canLoad) return null;
  try {
    // An inline require rather than import(): Metro defers both until this
    // line runs, so the laziness is identical on the device — but Jest's CJS
    // sandbox cannot execute a native import() at all, and this path was
    // untestable as one.
    return require("expo-notifications") as Notifications;
  } catch {
    return null;
  }
}

/** Notifications arrive while the app is open too, and should be seen. */
function showWhileOpen(notifications: Notifications): void {
  notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

/**
 * Called once as the app starts, whether or not anyone opens Settings.
 *
 * iOS asks a running app what to do with a notification, and without a
 * handler expo-notifications answers "nothing": no banner, and nothing left
 * in Notification Center. The handler used to be set only by `enablePush`,
 * which runs when the Settings row is tapped, so after any relaunch every
 * notification that arrived while the app was open vanished — while the
 * server, still holding the token, kept sending (pre-release bug hunt).
 */
export function showNotificationsWhileOpen(): void {
  void load().then((notifications) => { if (notifications) showWhileOpen(notifications); });
}

/**
 * Whether the selected computer notifies this phone: a token this phone
 * registered with it, and permission to show what arrives.
 */
export async function pushEnabled(): Promise<boolean> {
  if (!(await savedPushToken())) return false;
  const notifications = await load();
  if (!notifications) return false;
  try {
    return (await notifications.getPermissionsAsync()).granted;
  } catch {
    return false;
  }
}

export async function enablePush(client: Api = api): Promise<PushResult> {
  if (!Device.isDevice) {
    return { ok: false, reason: "Push needs a real device — an emulator has no transport for it." };
  }

  const register = preparePushRegistration(client);
  const notifications = await load();
  if (!notifications) return { ok: false, reason: EXPO_GO_NOTE };

  try {
    showWhileOpen(notifications);

    // Android will not make a sound without a channel, and the server names
    // this one on every message it sends.
    if (process.env.EXPO_OS === "android") {
      await notifications.setNotificationChannelAsync("blocked", {
        name: "Waiting on you",
        importance: notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
      });
    }

    const existing = await notifications.getPermissionsAsync();
    const granted = existing.granted || (await notifications.requestPermissionsAsync()).granted;
    if (!granted) return { ok: false, reason: "Notifications are turned off for this app." };

    // Expo mints tokens per project, so it has to be told which one.
    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
    if (!projectId) {
      return {
        ok: false,
        reason: "This build has no EAS project id, so Expo cannot issue a push token.",
      };
    }

    const { data: token } = await notifications.getExpoPushTokenAsync({ projectId });
    await register(token);
    return { ok: true, token };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/**
 * Routes a tapped notification to the pane it is about.
 *
 * The point of the notification is the answer that follows it, so it should
 * land on the prompt rather than on the list. The occupant that was waiting
 * comes too, when the server named one: herdr reuses pane ids, and a tap after
 * the id changed hands opened the new conversation (pre-release bug hunt).
 */
export function onNotificationTapped(open: (paneId: string, serverId?: string, instanceId?: string) => void): () => void {
  let remove: (() => void) | undefined;
  let cancelled = false;

  const route = (response: import("expo-notifications").NotificationResponse | null): string | null => {
    const paneId = response?.notification.request.content.data?.paneId;
    return typeof paneId === "string" && paneId ? paneId : null;
  };
  const deliver = (paneId: string, response: import("expo-notifications").NotificationResponse | null) => {
    const data = response?.notification.request.content.data;
    const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
    const serverId = typeof data?.serverId === "string" ? data.serverId : undefined;
    const instanceId = text(data?.instanceId);
    if (instanceId) open(paneId, serverId, instanceId);
    else if (serverId !== undefined) open(paneId, serverId);
    else open(paneId);
  };

  void load().then((notifications) => {
    if (!notifications || cancelled) return;

    // The tap that cold-launched the app from a killed state is delivered before
    // any listener can attach — and this listener attaches only after the connect
    // gate — so the live listener alone misses it. getLastNotificationResponseAsync
    // returns that launching response so the deep link still lands; clear it after
    // routing, since it persists and would otherwise re-open the pane on a later
    // remount. (router audit)
    void notifications.getLastNotificationResponseAsync().then((response) => {
      if (cancelled) return;
      const paneId = route(response);
      if (paneId) {
        deliver(paneId, response);
        void notifications.clearLastNotificationResponseAsync();
      }
    });

    const subscription = notifications.addNotificationResponseReceivedListener((response) => {
      const paneId = route(response);
      if (paneId) deliver(paneId, response);
    });
    remove = () => subscription.remove();
  });

  return () => {
    cancelled = true;
    remove?.();
  };
}
