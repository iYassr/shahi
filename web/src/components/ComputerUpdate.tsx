import { useLocale } from "../i18n";
import { createContext, useContext, useEffect, useMemo, useReducer, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { ControlSession, controlMessage, controlNeedsAttention, updateInProgress } from "@shahi/shared";
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
/** `linkDown`: the connection card is already saying this computer cannot be reached. */
export function ComputerUpdate({ linkDown = false }: { linkDown?: boolean }) {
  const { t, locale } = useLocale();
  const control = useComputerControl();
  const settings = useLocation().pathname === "/settings";
  const h = control?.handshake;
  if (!h || !control) return null;
  const busy = control.pending || updateInProgress(h.update.phase);
  // herdr merely stopped is the connection banner's news, and so is a
  // computer that cannot be reached; not said twice (see `controlNeedsAttention`).
  // Offline is read here, at render: WebKit keeps the socket "live" with the
  // network gone, and the connection card says "You’re offline" from this.
  if (!settings && !controlNeedsAttention(h, control, linkDown || !navigator.onLine)) return null;
  return <section className="computer-update" aria-live="polite">
    <strong>{h.backend.state.includes("update-required") ? t("Update required") : h.update.available ? t("Update available") : t("This computer")}</strong>
    <p>{control.pending ? t("Requesting update…") : control.error ? (updateInProgress(h.update.phase) ? t("Reconnecting after the update…") : t("Computer unavailable. Your pairing is saved.")) : controlMessage(h, locale)}</p>
    {control.error && <p role="alert">{t(control.error)}</p>}
    {h.update.managed && <div className="computer-update__actions">
      {h.update.available && <button disabled={busy} onClick={() => void control.request("install")}>{t("Update computer")}</button>}
      <button disabled={busy} onClick={() => void control.request("check")}>{t("Check for updates")}</button>
      {settings && <label>{t("Release channel")}{" "}<select disabled={busy} value={h.update.channel} onChange={e => void control.request("check", e.target.value as "stable" | "beta")}><option value="stable">{t("Stable")}</option><option value="beta">{t("Beta")}</option></select></label>}
    </div>}
    {settings && h.update.managed && <p>{t("Beta receives releases earlier. Returning to Stable keeps this release until a compatible Stable update is available.")}</p>}
  </section>;
}
