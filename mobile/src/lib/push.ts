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
import { api } from "@/lib/api";

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

export async function enablePush(): Promise<PushResult> {
  if (!Device.isDevice) {
    return { ok: false, reason: "Push needs a real device — an emulator has no transport for it." };
  }

  const notifications = await load();
  if (!notifications) return { ok: false, reason: EXPO_GO_NOTE };

  try {
    // Notifications arrive while the app is open too, and should be seen.
    notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });

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
    await api.registerPush(token);
    return { ok: true, token };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/**
 * Routes a tapped notification to the pane it is about.
 *
 * The point of the notification is the answer that follows it, so it should
 * land on the prompt rather than on the list.
 */
export function onNotificationTapped(open: (paneId: string) => void): () => void {
  let remove: (() => void) | undefined;
  let cancelled = false;

  const route = (response: import("expo-notifications").NotificationResponse | null): string | null => {
    const paneId = response?.notification.request.content.data?.paneId;
    return typeof paneId === "string" && paneId ? paneId : null;
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
        open(paneId);
        void notifications.clearLastNotificationResponseAsync();
      }
    });

    const subscription = notifications.addNotificationResponseReceivedListener((response) => {
      const paneId = route(response);
      if (paneId) open(paneId);
    });
    remove = () => subscription.remove();
  });

  return () => {
    cancelled = true;
    remove?.();
  };
}
