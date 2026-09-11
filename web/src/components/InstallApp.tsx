import { useEffect, useState } from "react";
import { SetupIcon } from "./SetupIcon";

interface InstallPrompt extends Event {
  prompt(): Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** Browser installation is optional; iOS exposes it through the Share menu. */
export function InstallApp() {
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
    <summary><span className="app-help__install-label"><SetupIcon name="install" size={20} /><span>Install Shahi on this device</span></span></summary>
    <p>Open Shahi from your Home Screen or Dock. Your computer needs to stay on and connected to use its sessions.</p>
    {prompt && <button className="empty__action app-help__install-label" onClick={() => { const current = prompt; setPrompt(null); void current.prompt().catch(() => {}); }}><SetupIcon name="install" size={20} /><span>Install Shahi</span></button>}
    <ul>
      <li><strong>iPhone or iPad:</strong> open the browser’s Share menu, then Add to Home Screen.</li>
      <li><strong>Android or Chrome:</strong> use the browser’s Install app or Add to Home Screen option.</li>
      <li><strong>Safari on Mac:</strong> choose File → Add to Dock.</li>
    </ul>
    <p>Open the installed app, then pair with Remember this browser selected on your personal device. Some browsers keep installed apps’ access separate.</p>
  </details>;
}
