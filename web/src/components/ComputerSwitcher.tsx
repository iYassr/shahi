import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { browserConnection, browserComputers, selectBrowserComputer } from "../connection";

export function useComputers() {
  const [, update] = useState(0);
  useEffect(() => {
    const changed = () => update(n => n + 1);
    window.addEventListener("shahi:computers-updated", changed);
    return () => window.removeEventListener("shahi:computers-updated", changed);
  }, []);
  return browserComputers();
}
export function ComputerSwitcher({ onManage }: { onManage: () => void }) {
  const computers = useComputers();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const current = browserConnection().identity?.serverId;
  const name = computers.find(c => c.id === current)?.name || "Computers";
  return <details className="computer-switcher">
    <summary aria-label="Switch computer">{name} ▾</summary>
    <div className="computer-switcher__menu">
      {computers.map(c => <button key={c.id} aria-label={`Switch to ${c.name}`} onClick={() => {
        void selectBrowserComputer(c.id).then(() => navigate("/", { replace: true })).catch(e => setError(e.message));
      }}>
        <span>{current === c.id ? "✓ " : ""}{c.name}</span>
        <small>{c.address} · {c.id.slice(0, 8)}</small>
        <small>{c.state === "live" ? "Connected" : c.state === "lost" ? "Offline · retrying" : "Connecting…"}</small>
      </button>)}
      {error && <p role="alert">{error}</p>}
      <button onClick={onManage}>Manage computers</button>
    </div>
  </details>;
}
