import { LanguagePicker, useLocale } from "../i18n";
import { useComputers } from "./ComputerSwitcher";
import { UiIcon } from "./UiIcon";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { browserConnection, selectBrowserComputer, revokeBrowserComputer, renameBrowserComputer } from "../connection";

export function Computers({ onClose }: { onClose?: () => void }) {
  const { t } = useLocale();
  const computers = useComputers().map(computer => ({ ...computer, name: computer.named ? computer.name : t("Your computer") }));
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
    <header className="topbar"><h1 className="topbar__title"><UiIcon name="computer" size={26} /> {" "}{t("Computers")}</h1><span className="topbar__spacer" />{onClose && <button className="topbar__action" onClick={onClose}>{t("Back")}</button>}</header>
    <main className="settings computers scroll">
    <LanguagePicker />
    <div className="page-intro"><h2>{t("All your computers, together")}</h2><p>{t("Switch in one tap. All computers stay connected while Shahi is open. Select Remember this browser when connecting to keep access after closing the app.")}</p></div>
    {computers.length === 0 && <div className="empty"><span className="empty__mark"><UiIcon name="computer" size={40} /></span><h2>{t("Add your first computer")}</h2><p>{t("Scan the code on your computer to see your work here.")}</p></div>}
    {computers.map(computer => <section className="computer-card" data-current={browserConnection().identity?.serverId === computer.id} key={computer.id}>
      <div className="computer-card__heading"><span className="space__icon"><UiIcon name="computer" size={24} /></span><div><h2>{computer.name}</h2><span className={`computer-state computer-state--${computer.state}`}>{computer.state === "live" ? t("Connected") : computer.state === "lost" ? t("Offline · retrying") : t("Connecting…")}</span></div></div><p>{computer.address} · {computer.remembered ? t("Remembered") : t("Until this page closes")}</p>
      <div className="computer-card__actions">
      <button className="empty__action" disabled={busy} onClick={() => void choose(computer.id)} aria-label={t("Connect to {value0}, {value1}", { value0: computer.name, value1: computer.address })}>
        {browserConnection().identity?.serverId === computer.id ? t("✓ Viewing") : t("Open agents")}
      </button>
      <button disabled={busy} onClick={() => { setRenaming(computer.id); setName(computer.name); }}>{t("Rename")}</button>
      {/* Named for its computer: with two saved, both read "Revoke this
          browser's access" and a screen reader could not tell which one
          would be cut off (pre-release bug hunt). */}
      <button className="settings__signout" disabled={busy} aria-label={t("Revoke this browser’s access to {value0}, {value1}", { value0: computer.name, value1: computer.address })} onClick={() => {
        if (!window.confirm(t("Remove this browser’s access to {value0}? A new pairing code will be needed. Other computers stay connected.", { value0: computer.name }))) return;
        setBusy(true);
        void revokeBrowserComputer(computer.id).catch(e => setError(e.message)).finally(() => setBusy(false));
      }}>{t("Revoke this browser’s access")}</button>
      </div>
      {renaming === computer.id && <form onSubmit={event => {
        event.preventDefault(); setBusy(true); setError("");
        void renameBrowserComputer(computer.id, name).then(() => setRenaming(null)).catch(e => setError(e.message)).finally(() => setBusy(false));
      }}>
        <label>{t("Computer name")}{" "}<input value={name} maxLength={80} onChange={event => setName(event.target.value)} autoFocus /></label>
        <button disabled={busy || !name.trim()}>{t("Save name")}</button>
        <button type="button" onClick={() => setRenaming(null)}>{t("Cancel")}</button>
      </form>}
    </section>)}
    {error && <p role="alert">{t(error)}</p>}
    <button className="empty__action" disabled={busy} onClick={() => void choose(null)}>{t("Add a computer")}</button>
    <p>{t("To manage phones and browsers allowed into a computer, select it and open Settings → Devices with access.")}</p>
  </main></>;
}
