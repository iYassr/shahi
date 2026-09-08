import { useComputers } from "./ComputerSwitcher";
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
  return <main className="settings scroll">
    <header className="topbar"><h1>Computers</h1>{onClose && <button onClick={onClose}>Back</button>}</header>
    <p>All computers stay connected while Shahi is open. Only remembered connections survive a reload.</p>
    {computers.map(computer => <section key={computer.id}>
      <h2>{computer.name}</h2><p>{computer.state === "live" ? "Connected" : computer.state === "lost" ? "Offline · retrying" : "Connecting…"}</p><p>{computer.address} · {computer.remembered ? "Remembered" : "Until this page closes"}</p>
      <button className="empty__action" disabled={busy} onClick={() => void choose(computer.id)} aria-label={`Connect to ${computer.name}, ${computer.address}`}>
        {browserConnection().identity?.serverId === computer.id ? "Current computer" : "Connect"}
      </button>
      <button className="settings__signout" disabled={busy} onClick={() => {
        if (!window.confirm(`Revoke this browser’s access to ${computer.name}? A new pairing code will be needed. Other computers stay connected.`)) return;
        setBusy(true);
        void revokeBrowserComputer(computer.id).catch(e => setError(e.message)).finally(() => setBusy(false));
      }}>Revoke this browser’s access</button>
    </section>)}
    {error && <p role="alert">{error}</p>}
    <button className="empty__action" disabled={busy} onClick={() => void choose(null)}>Add a computer</button>
    <p>Previously replaced connections need a new pairing code once. Devices with access in Settings lists browsers and phones allowed into the current computer.</p>
  </main>;
}
