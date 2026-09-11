import { useEffect, useRef, useState } from "react";
import { UiIcon } from "./UiIcon";
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
  const menu = useRef<HTMLDetailsElement>(null);
  const close = () => { if (menu.current) menu.current.open = false; };
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !menu.current?.contains(event.target)) close(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && menu.current?.open) { close(); menu.current.querySelector("summary")?.focus(); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, []);
  const current = browserConnection().identity?.serverId;
  const name = computers.find(c => c.id === current)?.name || "Computers";
  return <details className="computer-switcher" ref={menu}>
    <summary aria-label="Switch computer"><UiIcon name="computer" /><span className="computer-switcher__name">{name}</span><span className="computer-switcher__hint">Switch computer</span><UiIcon name="chevron" size={16} /></summary>
    <div className="computer-switcher__menu">
      <p className="computer-switcher__caption">Your computers · {computers.length}</p>
      {computers.map(c => <button key={c.id} aria-current={current === c.id ? "true" : undefined} aria-label={`Switch to ${c.name}`} onClick={() => {
        setError("");
        void selectBrowserComputer(c.id).then(() => { close(); navigate("/", { replace: true }); }).catch(e => setError(e.message));
      }}>
        <span className="computer-switcher__row-title">{c.name}{current === c.id && <UiIcon name="check" size={16} />}</span>
        <small>{c.address}</small>
        <small className={`computer-state computer-state--${c.state}`}>{c.state === "live" ? "Connected" : c.state === "lost" ? "Offline · retrying" : "Connecting…"}</small>
      </button>)}
      {error && <p role="alert">{error}</p>}
      <button className="computer-switcher__manage" onClick={() => { close(); onManage(); }}>Manage computers</button>
    </div>
  </details>;
}
