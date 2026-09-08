import { createContext, useContext, useEffect, useMemo, useReducer, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { ControlSession, controlMessage, updateInProgress } from "@shahi/shared";
import { useApi } from "../api";

const ControlContext = createContext<{ control: ControlSession } | null>(null);
export const useComputerControl = () => useContext(ControlContext)?.control ?? null;
export function ComputerControlProvider({ onRecovered, children }: { onRecovered: () => void; children: ReactNode }) {
  const api = useApi();
  const [, redraw] = useReducer(n => n + 1, 0);
  const control = useMemo(() => new ControlSession(api, redraw, onRecovered), [api, onRecovered]);
  useEffect(() => { control.start(); return () => control.stop(); }, [control]);
  return <ControlContext.Provider value={{ control }}>{children}</ControlContext.Provider>;
}
export function ComputerUpdate() {
  const control = useComputerControl();
  const settings = useLocation().pathname === "/settings";
  const h = control?.handshake;
  if (!h || !control) return null;
  const busy = control.pending || updateInProgress(h.update.phase);
  if (!settings && h.backend.state === "connected" && !h.update.available && !busy && !h.update.message && !control.error) return null;
  return <section className="computer-update" aria-live="polite">
    <strong>{h.backend.state.includes("update-required") ? "Update required" : h.update.available ? "Update available" : "This computer"}</strong>
    <p>{control.pending ? "Requesting update…" : control.error ? (updateInProgress(h.update.phase) ? "Reconnecting after the update…" : "Computer unavailable. Your pairing is saved.") : controlMessage(h)}</p>
    {control.error && <p role="alert">{control.error}</p>}
    {h.update.managed && <div className="computer-update__actions">
      {h.update.available && <button disabled={busy} onClick={() => void control.request("install")}>Update computer</button>}
      <button disabled={busy} onClick={() => void control.request("check")}>Check for updates</button>
      {settings && <label>Release channel <select disabled={busy} value={h.update.channel} onChange={e => void control.request("check", e.target.value as "stable" | "beta")}><option value="stable">Stable</option><option value="beta">Beta</option></select></label>}
    </div>}
    {settings && h.update.managed && <p>Beta receives releases earlier. Returning to Stable keeps this release until a compatible Stable update is available.</p>}
  </section>;
}
