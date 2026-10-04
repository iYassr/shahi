import { useLocale } from "../i18n";
import { useEffect, useState } from "react";
import { SetupIcon } from "./SetupIcon";

interface InstallPrompt extends Event {
  prompt(): Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** Browser installation is optional; iOS exposes it through the Share menu. */
export function InstallApp() {
  const { t } = useLocale();
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [installed, setInstalled] = useState(() => window.matchMedia("(display-mode: standalone)").matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
  useEffect(() => {
    const available = (event: Event) => { event.preventDefault(); setPrompt(event as InstallPrompt); };
    const done = () => { setInstalled(true); setPrompt(null); };
    window.addEventListener("beforeinstallprompt", available);
    window.addEventListener("appinstalled", done);
    return () => { window.removeEventListener("beforeinstallprompt", available); window.removeEventListener("appinstalled", done); };
  }, []);
  if (installed) return null;
  return <details className="app-help">
    <summary><span className="app-help__install-label"><SetupIcon name="install" size={20} /><span>{t("Install Shahi on this device")}</span></span></summary>
    <p>{t("Open Shahi from your Home Screen or Dock. Your computer needs to stay on and connected to continue your work.")}</p>
    {prompt && <button className="empty__action app-help__install-label" onClick={() => { const current = prompt; setPrompt(null); void current.prompt().catch(() => {}); }}><SetupIcon name="install" size={20} /><span>{t("Install Shahi")}</span></button>}
    <ul>
      <li><strong>{t("iPhone or iPad:")}</strong> {" "}{t("open the browser’s Share menu, then Add to Home Screen.")}</li>
      <li><strong>{t("Android or Chrome:")}</strong> {" "}{t("use the browser’s Install app or Add to Home Screen option.")}</li>
      <li><strong>{t("Safari on Mac:")}</strong> {" "}{t("choose File → Add to Dock.")}</li>
    </ul>
    <p>{t("Open the installed app, then pair with Remember this browser selected on your personal device. Some browsers keep installed apps’ access separate.")}</p>
  </details>;
}
