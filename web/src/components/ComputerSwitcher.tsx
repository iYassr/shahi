import { useLocale } from "../i18n";
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
  const { t } = useLocale();
  const computers = useComputers().map(computer => ({ ...computer, name: computer.named ? computer.name : t("Your computer") }));
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
  const name = computers.find(c => c.id === current)?.name || t("Computers");
  const waiting = computers.filter(c => c.id !== current && c.state === "live").reduce((n, c) => n + c.waiting, 0);
  return <details className="computer-switcher" ref={menu}>
    <summary aria-label={t("Switch computer")} aria-description={waiting ? t("{value0} waiting on other computers", { value0: waiting }) : undefined}><UiIcon name="computer" /><span className="computer-switcher__name">{name}</span>{waiting > 0 && <span>{waiting} {" "}{t("waiting")}</span>}<span className="computer-switcher__hint">{t("Switch computer")}</span><UiIcon name="chevron" size={16} /></summary>
    <div className="computer-switcher__menu">
      <p className="computer-switcher__caption">{t("Your computers ·")}{" "}{computers.length}</p>
      {computers.map(c => <button key={c.id} aria-current={current === c.id ? "true" : undefined} aria-label={t("Switch to {value0}", { value0: c.name })} onClick={() => {
        setError("");
        void selectBrowserComputer(c.id).then(() => { close(); navigate("/", { replace: true }); }).catch(e => setError(e.message));
      }}>
        <span className="computer-switcher__row-title">{c.name}{current === c.id && <UiIcon name="check" size={16} />}</span>
        <small>{c.address}</small>
        <small className={`computer-state computer-state--${c.state}`}>{c.state === "live" ? t("Connected") : c.state === "lost" ? t("Offline · retrying") : t("Connecting…")}{c.waiting ? t("· {value0} waiting{value1}", { value0: c.waiting, value1: c.state === "live" ? "" : ` ${t("(last known)")}` }) : ""}</small>
      </button>)}
      {error && <p role="alert">{t(error)}</p>}
      <button className="computer-switcher__manage" onClick={() => { close(); onManage(); }}>{t("Manage computers")}</button>
    </div>
  </details>;
}
