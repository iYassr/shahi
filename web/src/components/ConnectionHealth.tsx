import { useEffect, useState } from "react";
import { connectionHealth } from "@shahi/shared";

export function ConnectionHealth({ link, error, relay, onRetry }: {
  link: "connecting" | "live" | "lost"; error: Error | null; relay: boolean; onRetry: () => Promise<void>;
}) {
  const [online, setOnline] = useState(navigator.onLine);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update); window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);
  const health = connectionHealth({ link, error, online, transport: relay ? "relay" : "direct" });
  if (!health) return null;
  return <div className="connection-health" role="status">
    <div><strong>{health.title}</strong><p>{health.detail}</p><small>Live updates resume when the connection returns.</small></div>
    <button disabled={busy || !online} onClick={() => { setBusy(true); void onRetry().finally(() => setBusy(false)); }}>{busy ? "Retrying…" : "Retry connection"}</button>
  </div>;
}
