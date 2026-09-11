import { useComputers } from "./ComputerSwitcher";
import { UiIcon } from "./UiIcon";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { browserConnection, selectBrowserComputer, revokeBrowserComputer } from "../connection";

export function Computers({ onClose }: { onClose?: () => void }) {
  const computers = useComputers();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function choose(id: string | null) {
    setBusy(true); setError("");
    try { navigate("/", { replace: true }); await selectBrowserComputer(id); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  }
  return <>
    <header className="topbar"><h1 className="topbar__title"><UiIcon name="computer" size={26} /> Computers</h1><span className="topbar__spacer" />{onClose && <button className="topbar__action" onClick={onClose}>Back</button>}</header>
    <main className="settings computers scroll">
    <div className="page-intro"><h2>All your computers, together</h2><p>Switch in one tap. All computers stay connected while Shahi is open. Remember a pairing to reconnect after closing the app.</p></div>
    {computers.length === 0 && <div className="empty"><span className="empty__mark"><UiIcon name="computer" size={40} /></span><h2>Add your first computer</h2><p>Pair with its QR code to bring your agents here.</p></div>}
    {computers.map(computer => <section className="computer-card" data-current={browserConnection().identity?.serverId === computer.id} key={computer.id}>
      <div className="computer-card__heading"><span className="space__icon"><UiIcon name="computer" size={24} /></span><div><h2>{computer.name}</h2><span className={`computer-state computer-state--${computer.state}`}>{computer.state === "live" ? "Connected" : computer.state === "lost" ? "Offline · retrying" : "Connecting…"}</span></div></div><p>{computer.address} · {computer.remembered ? "Remembered" : "Until this page closes"}</p>
      <div className="computer-card__actions">
      <button className="empty__action" disabled={busy} onClick={() => void choose(computer.id)} aria-label={`Connect to ${computer.name}, ${computer.address}`}>
        {browserConnection().identity?.serverId === computer.id ? "Current computer" : "Connect"}
      </button>
      <button className="settings__signout" disabled={busy} onClick={() => {
        if (!window.confirm(`Revoke this browser’s access to ${computer.name}? A new pairing code will be needed. Other computers stay connected.`)) return;
        setBusy(true);
        void revokeBrowserComputer(computer.id).catch(e => setError(e.message)).finally(() => setBusy(false));
      }}>Revoke this browser’s access</button>
      </div>
    </section>)}
    {error && <p role="alert">{error}</p>}
    <button className="empty__action" disabled={busy} onClick={() => void choose(null)}>Add a computer</button>
    <p>To manage phones and browsers allowed into a computer, select it and open Settings → Devices with access.</p>
  </main></>;
}
