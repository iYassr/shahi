import { useEffect, useRef, useState, type ReactNode } from "react";
import { ClientUpdateCheck, UPDATE_CHECK_MS, WEB_CLIENT_BUILD, type UpdateRule } from "@shahi/shared/client-update";
import { newerBundleDeployed } from "../version";
import { hasUnsentDrafts } from "../drafts";
import { hosted } from "../connection";

/** Hosted policy never locks a local computer's independently released UI. */
export function ClientUpdateGate({ children }: { children: ReactNode }) {
  const [rule, setRule] = useState<UpdateRule | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const checker = useRef<ClientUpdateCheck | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!hosted) return;
    let live = true;
    const check = new ClientUpdateCheck({ platform: "web", build: WEB_CLIENT_BUILD,
      load: async () => localStorage.getItem("shahi.client-update.v1"),
      save: async text => { localStorage.setItem("shahi.client-update.v1", text); },
      changed: value => { if (live) setRule(value); },
    });
    checker.current = check;
    void check.restore().then(() => { if (live) void check.check(); });
    const foreground = () => { if (!document.hidden) void check.check(); };
    const timer = setInterval(foreground, UPDATE_CHECK_MS);
    document.addEventListener("visibilitychange", foreground);
    return () => { live = false; checker.current = null; clearInterval(timer); document.removeEventListener("visibilitychange", foreground); };
  }, []);
  useEffect(() => { if (rule) dialog.current?.focus(); }, [!!rule]);
  async function retry() {
    setBusy(true);
    const ok = await checker.current?.check(true);
    setBusy(false);
    setNotice(ok ? "The update is still required. Reload to install it." : "Could not check right now. Check your connection and try again.");
  }
  async function reload() {
    setBusy(true); setNotice("");
    // The policy may arrive before the assets. Never send someone into a loop.
    const ready = await newerBundleDeployed();
    setBusy(false);
    if (!ready) { setNotice("The update is not available here yet. Try again shortly."); return; }
    if (hasUnsentDrafts() && !window.confirm("Reloading will discard unsent replies and attachments. Check the conversation before retrying an uncertain send. Saved computers are kept. Reload now?")) return;
    location.reload();
  }
  return <>
    <div style={{ display: "contents" }} inert={!!rule} aria-hidden={rule ? true : undefined}>{children}</div>
    {rule && <div className="client-update" role="dialog" aria-modal="true" aria-labelledby="client-update-title" tabIndex={-1} ref={dialog}>
      <div className="client-update__card">
        <h1 id="client-update-title">Update Shahi</h1>
        <p>{rule.message}</p>
        <p>Reload to install the latest version and continue. Your saved computers are kept.</p>
        <button disabled={busy} onClick={() => void reload()}>Reload Shahi</button>
        <button disabled={busy} onClick={() => void retry()}>Check again</button>
        {!!notice && <p role="status">{notice}</p>}
      </div>
    </div>}
  </>;
}
