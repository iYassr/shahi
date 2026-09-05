import { browserConnection, hosted } from "../connection";
import { checkPushConnection } from "../push-policy";
import { preferences } from "../preferences";
/**
 * Offers notifications, and explains the iOS prerequisite when it applies.
 *
 * iOS only grants Web Push to a PWA opened from the home screen. Asking for
 * permission in Safari there fails silently, so the banner says what to do
 * instead of offering a button that cannot work.
 *
 * And on iOS the `Notification` global does not merely refuse — it does not
 * exist at all outside a home-screen app. Touching it threw a ReferenceError
 * during the first render, which took the whole app down with it: the entire
 * dashboard was a blank page in a Safari tab. Found the day this suite started
 * running in WebKit, having been invisible in Chromium for the life of the
 * project.
 */
import { useEffect, useState } from "react";
import { api } from "../api";

type State = "hidden" | "needs-install" | "offer" | "asking" | "done";

const isIos = () =>
  /iP(hone|ad|od)/.test(navigator.userAgent) ||
  // iPadOS reports as a Mac; touch points give it away.
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  (navigator as { standalone?: boolean }).standalone === true;

/** The API, or nothing — which is what iOS gives a browser tab. */
const notifications = (): typeof Notification | null =>
  typeof window !== "undefined" && "Notification" in window ? window.Notification : null;

export function PushPrompt({ onToast }: { onToast: (message: string) => void }) {
  const [state, setState] = useState<State>("hidden");

  useEffect(() => {
    if (hosted && !browserConnection().remembered) return;
    if (preferences.get("shahi.push.dismissed") === "1") return;
    if (!("serviceWorker" in navigator)) return;

    const api = notifications();
    if (!api) {
      // No API at all: a Safari tab on iOS. Installing to the home screen is
      // the only route, and that is what the banner says.
      setState(isIos() && !isStandalone() ? "needs-install" : "hidden");
      return;
    }

    if (api.permission === "granted" && !hosted) {
      void registerPush().catch(() => {});
      return;
    }
    if (api.permission === "denied") return;

    setState(isIos() && !isStandalone() ? "needs-install" : "offer");
  }, []);

  async function enable() {
    setState("asking");
    try {
      const generation = browserConnection().generation;
      checkPushConnection(hosted, browserConnection(), generation);
      const api = notifications();
      if (!api) throw new Error("This browser cannot show notifications here.");
      if ((await api.requestPermission()) !== "granted") {
        onToast("Notifications stayed off");
        setState("hidden");
        return;
      }
      await registerPush(generation);
      setState("done");
      onToast("Notifications on");
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Could not turn on notifications");
      setState("offer");
    }
  }

  function dismiss() {
    preferences.set("shahi.push.dismissed", "1");
    setState("hidden");
  }

  if (state === "hidden" || state === "done") return null;

  if (state === "needs-install") {
    return (
      <div className="banner">
        <strong>Add Shahi to your Home Screen</strong> to get notified when an
        agent needs you. iOS only delivers notifications to installed apps — tap
        Share, then Add to Home Screen.
        <button onClick={dismiss}>Not now</button>
      </div>
    );
  }

  return (
    <div className="banner">
      <strong>Get notified when an agent blocks.</strong> Your phone buzzes as
      soon as one needs an answer, so you do not have to keep checking.
      <button onClick={() => void enable()} disabled={state === "asking"}>
        {state === "asking" ? "Asking…" : "Turn on notifications"}
      </button>
      <button onClick={dismiss}>Not now</button>
    </div>
  );
}

export async function registerPush(expectedGeneration = browserConnection().generation): Promise<void> {
  const check = () => checkPushConnection(hosted, browserConnection(), expectedGeneration);
  check();
  const { publicKey } = await api.pushKey();
  check();
  if (!publicKey) throw new Error("Push is not configured on the server");
  const registration = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL });
  check();
  await navigator.serviceWorker.ready;
  check();
  let subscription = await registration.pushManager.getSubscription();
  check();
  let created = false;
  try {
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
      created = true;
    }
    check();
    await api.pushSubscribe(subscription.toJSON());
    check();
  } catch (error) {
    // Never remove a subscription another newly paired computer may have adopted.
    const current = browserConnection();
    if (created && subscription && (current.generation === expectedGeneration || !current.identity)) await subscription.unsubscribe().catch(() => {});
    throw error;
  }
}

/**
 * VAPID keys are base64url; PushManager wants raw bytes.
 *
 * Returns an ArrayBuffer rather than a Uint8Array: the DOM types require a
 * buffer explicitly backed by ArrayBuffer, which a plain Uint8Array does not
 * guarantee (it may be backed by a SharedArrayBuffer).
 */
function urlBase64ToUint8Array(base64Url: string): ArrayBuffer {
  const padded = base64Url.padEnd(base64Url.length + ((4 - (base64Url.length % 4)) % 4), "=");
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
