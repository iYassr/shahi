import { Logo } from "./Logo";
import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { browserConnection, pairBrowser } from "../connection";

export function PairBrowser({ initialCode, onConsumed, onSuccess }: { initialCode: string; onConsumed(): void; onSuccess(): void }) {
  const [code, setCode] = useState(initialCode);
  const [name, setName] = useState("Web browser");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  return <main className="pair-browser">
    <div className="pair-browser__intro"><span className="pair-browser__mark" aria-hidden="true"><Logo size={56} /></span><h1>Connect your computer</h1><p>Read agent conversations and answer prompts in your browser. Pair with the computer running herdr.</p></div>
    <form className="pair-browser__form" onSubmit={(event) => {
      event.preventDefault(); setBusy(true); setError("");
      const secret = code; setCode(""); onConsumed();
      void pairBrowser(secret, name, remember).then(onSuccess).catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
    }}>
      <h2>Pair this browser</h2><p>In herdr, open Shahi’s pairing action. Scan its QR code or paste the full pairing code below it.</p>
      <label htmlFor="pairing-code">Pairing code</label><textarea id="pairing-code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="shahi://pair#…" disabled={busy} />
      <button type="button" disabled={busy} onClick={() => { setScanning(true); setError(""); }}>Scan QR code</button>
      <label htmlFor="browser-name">Device name</label><input id="browser-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoComplete="off" disabled={busy} />
      <label className="pair-browser__remember"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} disabled={busy} />Remember this browser</label>
      <p className="pair-browser__note">{remember ? "Device access will be stored in this browser. Choose this only on a trusted personal device. Anyone using this browser profile can access your computer." : "Access stays in memory until you close or reload this page. Your pairing code is single-use."}</p>
      {error && <p role="alert" className="login__error">{error}</p>}
      <button type="submit" className="pair-browser__connect" disabled={busy || !code.trim()}>{busy ? "Connecting securely…" : "Connect"}</button>
      {error && browserConnection().identity && <button type="button" onClick={onSuccess}>Continue for this session</button>}
      <p className="pair-browser__note">Pairing grants control of herdr on your computer. You can revoke this browser from Settings on any paired device.</p>
    </form>
    {scanning && <QrScanner onCode={(value) => { setCode(value); setScanning(false); }} onClose={() => setScanning(false)} onError={(value) => { setError(value); setScanning(false); }} />}
  </main>;
}
function QrScanner({ onCode, onClose, onError }: { onCode(value: string): void; onClose(): void; onError(value: string): void }) {
  const video = useRef<HTMLVideoElement>(null);
  const callbacks = useRef({ onCode, onError }); callbacks.current = { onCode, onError };
  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { stopped = true; if (timer) clearTimeout(timer); stream?.getTracks().forEach((track) => track.stop()); };
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const scan = () => {
      if (stopped) return;
      const source = video.current;
      if (source && source.readyState >= 2 && context) {
        const scale = Math.min(1, 720 / source.videoWidth);
        canvas.width = Math.round(source.videoWidth * scale); canvas.height = Math.round(source.videoHeight * scale);
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        const result = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: "attemptBoth" });
        if (result?.data) { stop(); callbacks.current.onCode(result.data); return; }
      }
      timer = setTimeout(scan, 150);
    };
    void navigator.mediaDevices?.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false }).then(async (next) => {
      stream = next;
      if (stopped) { stop(); return; }
      if (video.current) { video.current.srcObject = next; await video.current.play(); }
      scan();
    }).catch(() => { stop(); callbacks.current.onError("Camera access is unavailable. Allow camera access in browser settings or paste the pairing code."); });
    if (!navigator.mediaDevices) callbacks.current.onError("This browser cannot use a camera here. Paste the pairing code instead.");
    const hide = () => { if (document.hidden) { stop(); callbacks.current.onError("Scanning stopped while the page was hidden. Tap Scan QR code to try again."); } };
    document.addEventListener("visibilitychange", hide);
    return () => { stop(); document.removeEventListener("visibilitychange", hide); };
  }, []);
  return <div className="viewer" role="dialog" aria-modal="true" aria-label="Scan pairing QR code"><header className="viewer__bar"><h2>Scan pairing QR code</h2><button onClick={onClose}>Cancel</button></header><video className="pair-browser__camera" ref={video} playsInline muted /><p>Point your camera at the QR code shown by Shahi in herdr.</p></div>;
}
