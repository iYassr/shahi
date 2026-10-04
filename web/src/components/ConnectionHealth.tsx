import { useLocale } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { connectionHealth, graceUntil, RECONNECT_GRACE_MS } from "@shahi/shared";
import { useComputerControl } from "./ComputerUpdate";
import { OtherComputers } from "./OtherComputers";

/**
 * When the page last became visible again. A reconnect met then usually
 * recovers by itself, so it gets the brief line (`graceUntil`), as on the phone.
 */
let resumedAt = 0;
if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") resumedAt = Date.now(); });

export function ConnectionHealth({ link, error, relay, onRetry }: {
  link: "connecting" | "live" | "lost"; error: Error | null; relay: boolean; onRetry: () => Promise<void>;
}) {
  const { t, locale } = useLocale();
  const [online, setOnline] = useState(navigator.onLine);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update); window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);
  // herdr's own state: the socket stays open while herdr is stopped.
  const backend = useComputerControl()?.handshake?.backend;
  const health = connectionHealth({ link, error, online, transport: relay ? "relay" : "direct", backend, locale });
  const seenLive = useRef(link === "live");
  if (link === "live") seenLive.current = true;
  const until = useRef<number | null>(null);
  const now = Date.now();
  until.current = graceUntil(until.current, !!health?.transient, seenLive.current || now - resumedAt < RECONNECT_GRACE_MS, now);
  const brief = !!health?.transient && until.current! > now;
  const [, escalate] = useState(0);
  useEffect(() => {
    if (!brief) return;
    const timer = setTimeout(() => escalate(n => n + 1), Math.max(0, until.current! - Date.now()));
    return () => clearTimeout(timer);
  }, [brief]);
  if (!health) return null;
  if (brief) return <div className="connection-health connection-health--brief" role="status"><span>{health.brief}</span></div>;
  return <div className="connection-health" role="status">
    <div><strong>{health.title}</strong><p>{health.detail}</p><small>{t("Live updates resume when the connection returns.")}</small></div>
    {relay && <OtherComputers />}
    <button disabled={busy || !online} onClick={() => { setBusy(true); void onRetry().finally(() => setBusy(false)); }}>{busy ? t("Retrying…") : t("Retry connection")}</button>
  </div>;
}
