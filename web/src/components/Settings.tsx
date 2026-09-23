import { UiIcon } from "./UiIcon";
import { Logo } from "./Logo";
import { checkPushConnection } from "../push-policy";
import { preferences } from "../preferences";
import { browserConnection, hosted } from "../connection";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DeviceList } from "@shahi/shared";
import { useApi } from "../api";
import { confirmSwitch, registerPush, unregisterPush } from "./PushPrompt";
import { InstallApp } from "./InstallApp";
import { noticesUrl } from "../notices";

export function Settings({ onToast, onLogout, onComputers }: { onComputers?: () => void; onToast: (message: string) => void; onLogout: () => void }) {
  const api = useApi();
  const [devices, setDevices] = useState<DeviceList | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const request = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current++; }; }, []);
  const refresh = useCallback(async () => {
    const generation = ++request.current;
    try {
      const list = await api.devices();
      if (mounted.current && generation === request.current) { setDevices(list); setError(""); }
    } catch (e) {
      if (mounted.current && generation === request.current) setError(e instanceof Error ? e.message : "Couldn't load devices");
    }
  }, [api]);
  useEffect(() => { setDevices(null); setError(""); void refresh(); }, [refresh]);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try { await action(); } catch (e) { onToast(e instanceof Error ? e.message : "Could not save settings"); } finally { setBusy(false); }
  }
  return <>
    <header className="topbar"><h1 className="topbar__title"><Logo size={28} /> Settings</h1></header>
    <div className="scroll settings">
      <div className="page-intro"><h2>Make Shahi yours</h2><p>Manage your computers, notifications, and who has access.</p></div>
      <InstallApp />
      {hosted && <section><h2><UiIcon name="computer" /> Computers</h2><p>Move between your connected computers. They stay connected while Shahi is open.</p><button className="empty__action" onClick={onComputers}>Switch or add a computer</button></section>}
      <section><h2><UiIcon name="shield" /> Connection</h2>{hosted ? <><p>Your messages are protected by encryption between this device and your computer.</p><details className="settings__details"><summary>Connection details</summary><p>{browserConnection().identity?.relay}</p></details><p>{browserConnection().remembered ? "This browser is remembered on this device." : "You’ll need a new connection code if you refresh or close this page."} Sign out to remove this browser’s access.</p></> : <><p>{location.host}</p><p>This browser connects through the address you opened. Keep your server or SSH tunnel running.</p></>}</section>
      <section><h2><UiIcon name="bell" /> Notifications</h2><p>Notify this browser when an agent needs you. On iPhone or iPad, add Shahi to your Home Screen first.</p>
        {hosted && <p>{browserConnection().remembered ? "Turn on notifications below to hear when this computer needs you." : "To receive notifications, connect again and select Remember this browser."}</p>}
        <button className="empty__action" disabled={busy || (hosted && !browserConnection().remembered)} onClick={() => void run(async () => {
          const generation = browserConnection().generation;
          checkPushConnection(hosted, browserConnection(), generation);
          if (!("Notification" in window)) throw new Error("Install Shahi on your Home Screen to enable notifications on this browser.");
          if (await Notification.requestPermission() !== "granted") throw new Error("Notifications are blocked in browser settings.");
          await registerPush(generation, confirmSwitch); preferences.remove("shahi.push.dismissed"); onToast("Notifications on");
        })}>Enable notifications</button>
        <button className="empty__action" disabled={busy} onClick={() => void run(async () => {
          await unregisterPush();
          preferences.set("shahi.push.dismissed", "1"); onToast("Notifications off");
        })}>Disable notifications</button>
      </section>
      <section><h2><UiIcon name="shield" /> Devices with access</h2><p>These devices can access the current computer. Revoking a device disconnects it and stops its notifications. Passcode logins do not appear in this list.</p>
        {error && <p className="settings__error" role="alert">{error}<button onClick={() => void refresh()}>Retry</button></p>}
        {!devices && !error && <p>Loading devices…</p>}
        {devices?.devices.length === 0 && <p>No paired devices.</p>}
        {devices?.devices.map((device) => <div className="device-row" key={device.id}><div><strong>{device.name}</strong><p>Last seen {new Date(device.lastSeenAt).toLocaleString()}</p></div><button disabled={busy} onClick={() => {
          const self = device.id === devices.thisDeviceId;
          if (window.confirm(self ? "Sign this browser out?" : `Revoke access for ${device.name}?`)) void run(async () => {
            await api.revokeDevice(device.id);
            if (!mounted.current) return;
            if (self) onLogout(); else await refresh();
          });
        }}>{device.id === devices.thisDeviceId ? "Sign out" : "Revoke"}</button></div>)}
      </section>
      <section className="settings__access"><h2>Sign out of this computer</h2><p>Remove this browser’s access. You will need to pair or sign in again to reconnect.</p><button className="empty__action settings__signout" disabled={busy} onClick={() => void run(async () => { try { await api.logout(); } finally { onLogout(); } })}>Sign out</button></section>
      <footer className="app-help__links"><a href="https://getshahi.dev/privacy" target="_blank" rel="noreferrer">Privacy</a><a href="mailto:support@getshahi.dev">Get help</a><a href={noticesUrl()} target="_blank" rel="noreferrer">Open-source licenses</a></footer>
    </div>
  </>;
}
