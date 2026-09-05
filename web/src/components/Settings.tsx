import { Logo } from "./Logo";
import { checkPushConnection } from "../push-policy";
import { preferences } from "../preferences";
import { browserConnection, hosted } from "../connection";
import { useEffect, useState } from "react";
import type { DeviceList } from "@shahi/shared";
import { api } from "../api";
import { registerPush } from "./PushPrompt";

export function Settings({ onToast, onLogout }: { onToast: (message: string) => void; onLogout: () => void }) {
  const [devices, setDevices] = useState<DeviceList | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = () => api.devices().then((list) => { setDevices(list); setError(""); }).catch((e) => setError(e.message));
  useEffect(() => { void refresh(); }, []);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try { await action(); } catch (e) { onToast(e instanceof Error ? e.message : "Could not save settings"); } finally { setBusy(false); }
  }
  return <>
    <header className="topbar"><h1 className="topbar__title"><Logo size={28} /> Settings</h1></header>
    <div className="scroll settings">
      <section><h2>Connection</h2>{hosted ? <><p>Encrypted relay · {browserConnection().identity?.relay}</p><p>{browserConnection().remembered ? "This browser is remembered on this device." : "This session is kept in memory. Reloading requires a new pairing code."} Sign out to revoke and remove this browser’s access.</p></> : <><p>{location.host}</p><p>This browser connects through the address you opened. Keep your server or SSH tunnel running.</p></>}</section>
      <section><h2>Notifications</h2><p>Notify this browser when an agent needs you. On iPhone or iPad, add Shahi to your Home Screen first.</p>
        {hosted && <p>{browserConnection().remembered ? "Enable notifications explicitly for this computer. Browser permission alone does not turn them on." : "Notifications need a remembered pairing. Pair again with Remember this browser selected to enable them."}</p>}
        <button className="empty__action" disabled={busy || (hosted && !browserConnection().remembered)} onClick={() => void run(async () => {
          const generation = browserConnection().generation;
          checkPushConnection(hosted, browserConnection(), generation);
          if (!("Notification" in window)) throw new Error("Install Shahi on your Home Screen to enable notifications on this browser.");
          if (await Notification.requestPermission() !== "granted") throw new Error("Notifications are blocked in browser settings.");
          await registerPush(generation); preferences.remove("shahi.push.dismissed"); onToast("Notifications on");
        })}>Enable notifications</button>
        <button className="empty__action" disabled={busy} onClick={() => void run(async () => {
          const generation = browserConnection().generation;
          const check = () => { if (hosted && browserConnection().generation !== generation) throw new DOMException("Connection changed", "AbortError"); };
          const registration = await navigator.serviceWorker?.getRegistration(import.meta.env.BASE_URL);
          check();
          const subscription = await registration?.pushManager.getSubscription();
          check();
          if (subscription) { await api.pushUnsubscribe(subscription.endpoint); check(); await subscription.unsubscribe(); }
          preferences.set("shahi.push.dismissed", "1"); onToast("Notifications off");
        })}>Disable notifications</button>
      </section>
      <section><h2>Paired devices</h2><p>Revoking a device disconnects it and stops its notifications. Passcode logins do not appear in this list.</p>
        {error && <p className="settings__error" role="alert">{error}<button onClick={() => void refresh()}>Retry</button></p>}
        {!devices && !error && <p>Loading devices…</p>}
        {devices?.devices.length === 0 && <p>No paired devices.</p>}
        {devices?.devices.map((device) => <div className="device-row" key={device.id}><div><strong>{device.name}</strong><p>Last seen {new Date(device.lastSeenAt).toLocaleString()}</p></div><button disabled={busy} onClick={() => {
          if (window.confirm(`Revoke access for ${device.name}?`)) void run(async () => { await api.revokeDevice(device.id); await refresh(); });
        }}>Revoke</button></div>)}
      </section>
      <button className="empty__action settings__signout" disabled={busy} onClick={() => void run(async () => { try { await api.logout(); } finally { onLogout(); } })}>Sign out</button>
    </div>
  </>;
}
