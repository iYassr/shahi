import { useComputers } from "./ComputerSwitcher";
import { UiIcon } from "./UiIcon";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { browserConnection, selectBrowserComputer, revokeBrowserComputer, renameBrowserComputer } from "../connection";

export function Computers({ onClose }: { onClose?: () => void }) {
  const computers = useComputers();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");
  async function choose(id: string | null) {
    setBusy(true); setError("");
    try { navigate("/", { replace: true }); await selectBrowserComputer(id); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  }
  return <>
    <header className="topbar"><h1 className="topbar__title"><UiIcon name="computer" size={26} /> Computers</h1><span className="topbar__spacer" />{onClose && <button className="topbar__action" onClick={onClose}>Back</button>}</header>
    <main className="settings computers scroll">
    <div className="page-intro"><h2>All your computers, together</h2><p>Switch in one tap. All computers stay connected while Shahi is open. Select Remember this browser when connecting to keep access after closing the app.</p></div>
    {computers.length === 0 && <div className="empty"><span className="empty__mark"><UiIcon name="computer" size={40} /></span><h2>Add your first computer</h2><p>Scan the code on your computer to see your work here.</p></div>}
    {computers.map(computer => <section className="computer-card" data-current={browserConnection().identity?.serverId === computer.id} key={computer.id}>
      <div className="computer-card__heading"><span className="space__icon"><UiIcon name="computer" size={24} /></span><div><h2>{computer.name}</h2><span className={`computer-state computer-state--${computer.state}`}>{computer.state === "live" ? "Connected" : computer.state === "lost" ? "Offline · retrying" : "Connecting…"}</span></div></div><p>{computer.address} · {computer.remembered ? "Remembered" : "Until this page closes"}</p>
      <div className="computer-card__actions">
      <button className="empty__action" disabled={busy} onClick={() => void choose(computer.id)} aria-label={`Connect to ${computer.name}, ${computer.address}`}>
        {browserConnection().identity?.serverId === computer.id ? "✓ Viewing" : "Open agents"}
      </button>
      <button disabled={busy} onClick={() => { setRenaming(computer.id); setName(computer.name); }}>Rename</button>
      {/* Named for its computer: with two saved, both read "Revoke this
          browser's access" and a screen reader could not tell which one
          would be cut off (pre-release bug hunt). */}
      <button className="settings__signout" disabled={busy} aria-label={`Revoke this browser’s access to ${computer.name}, ${computer.address}`} onClick={() => {
        if (!window.confirm(`Remove this browser’s access to ${computer.name}? A new pairing code will be needed. Other computers stay connected.`)) return;
        setBusy(true);
        void revokeBrowserComputer(computer.id).catch(e => setError(e.message)).finally(() => setBusy(false));
      }}>Revoke this browser’s access</button>
      </div>
      {renaming === computer.id && <form onSubmit={event => {
        event.preventDefault(); setBusy(true); setError("");
        void renameBrowserComputer(computer.id, name).then(() => setRenaming(null)).catch(e => setError(e.message)).finally(() => setBusy(false));
      }}>
        <label>Computer name <input value={name} maxLength={80} onChange={event => setName(event.target.value)} autoFocus /></label>
        <button disabled={busy || !name.trim()}>Save name</button>
        <button type="button" onClick={() => setRenaming(null)}>Cancel</button>
      </form>}
    </section>)}
    {error && <p role="alert">{error}</p>}
    <button className="empty__action" disabled={busy} onClick={() => void choose(null)}>Add a computer</button>
    <p>To manage phones and browsers allowed into a computer, select it and open Settings → Devices with access.</p>
  </main></>;
}
