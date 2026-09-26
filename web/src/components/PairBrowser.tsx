import { UiIcon } from "./UiIcon";
import { Logo } from "./Logo";
import { useEffect, useMemo, useRef, useState } from "react";
import jsQR from "jsqr";
import { browserConnection, pairBrowser, readPairing } from "../connection";
import { InstallApp } from "./InstallApp";
import { useDialog } from "../use-dialog";
import { SetupIcon } from "./SetupIcon";
import { noticesUrl } from "../notices";

/**
 * `initialCode` is a code that arrived in the page's `#pair=` fragment, from a
 * link rather than from anything the person did on this page.
 */
export function PairBrowser({ initialCode, onConsumed, onSuccess }: { initialCode: string; onConsumed(): void; onSuccess(): void }) {
  const [code, setCode] = useState(initialCode);
  const [name, setName] = useState("Web browser");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  /*
   * A linked code is shown for confirmation, never just pre-filled.
   *
   * Anyone can send a getshahi.dev/pwa/#pair= link for their own computer; it
   * opened straight onto a filled-in form whose Connect button attached this
   * browser to that stranger's computer, under whatever name it chose — even
   * a copy of the victim's own (pre-release review, 2026-09). The native app
   * has held linked codes on a confirm card since pentest M2; this is the
   * same card: who is asking, and where the browser would connect.
   */
  const [fromLink, setFromLink] = useState(Boolean(initialCode));
  const linked = useMemo(() => {
    if (!fromLink) return null;
    try {
      const payload = readPairing(code);
      return { host: new URL(payload.relay).host, identity: `${payload.server.slice(0, 16)}…`, error: "" };
    } catch (e) { return { host: "", identity: "", error: e instanceof Error ? e.message : "This pairing link is not valid." }; }
  }, [fromLink, code]);
  const dismissLink = () => { setFromLink(false); setCode(""); setError(""); onConsumed(); };
  /*
   * The card a link opens is what the person came for. On a phone the page is
   * one column with the setup steps first, and the card opened about 1000px
   * below the fold with focus left on the page (pre-release bug hunt,
   * 2026-09): the link seemed to have done nothing.
   */
  const form = useRef<HTMLFormElement>(null);
  const linkHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!initialCode) return;
    form.current?.scrollIntoView({ block: "start" });
    linkHeading.current?.focus({ preventScroll: true });
  }, []);
  return <main className="pair-browser">
    <div className="pair-browser__intro">
      <div className="pair-browser__welcome"><span className="pair-browser__mark" aria-hidden="true"><Logo size={56} /></span><span>Welcome to Shahi</span></div>
      <h1>Connect your computer</h1><p>Continue your work with Claude Code or Codex wherever you are. Start by connecting your computer.</p>
      <p><a className="pair-browser__jump" href="#pair-browser-form" onClick={(event) => { event.preventDefault(); document.getElementById("pair-browser-form")?.scrollIntoView({ block: "start" }); document.getElementById("pairing-code")?.focus({ preventScroll: true }); }}>Already have a code? Connect now ↓</a></p>
      <section className="app-help pair-browser__setup" aria-labelledby="computer-setup">
        <h2 id="computer-setup">Set up Shahi in 3 steps</h2>
        <p>On the Mac or Linux computer you want to connect, <a href="https://herdr.dev" target="_blank" rel="noreferrer">install and open herdr</a> first.</p>
        <ol role="list">
          <li><span className="pair-browser__step-icon"><SetupIcon name="install" /></span><div><strong><span className="pair-browser__step-number">1.</span> Add Shahi to your computer</strong><p>In herdr’s terminal (the window where you type commands), paste this line:</p><SetupCommand command="herdr plugin install iYassr/shahi" label="Copy install command" /></div></li>
          <li><span className="pair-browser__step-icon"><SetupIcon name="qr" /></span><div><strong><span className="pair-browser__step-number">2.</span> Show your connection code</strong><p>Then paste this line:</p><SetupCommand command="herdr plugin action invoke shahi.pair" label="Copy pairing command" /></div></li>
          <li><span className="pair-browser__step-icon"><SetupIcon name="devices" /></span><div><strong><span className="pair-browser__step-number">3.</span> Connect this browser</strong><p>Scan the QR code on your computer, or copy its full code into the form below.</p></div></li>
        </ol>
        <p>Keep herdr open and your computer connected to the internet.</p>
      </section>
      <InstallApp />
      <p className="app-help__links"><a href="https://getshahi.dev/privacy">Privacy</a><a href="mailto:support@getshahi.dev">Support</a><a href={noticesUrl()} target="_blank" rel="noreferrer">Open-source licenses</a></p>
    </div>
    <form ref={form} id="pair-browser-form" className="pair-browser__form" onSubmit={(event) => {
      event.preventDefault();
      if (linked?.error) return;
      setBusy(true); setError("");
      /*
       * The code is spent only by a claim that succeeded. It was cleared
       * before the attempt, so an offline computer or a dropped relay also
       * emptied the field, and a linked code lost its card, although the
       * same code would still pair (pre-release bug hunt, 2026-09). A claim
       * that succeeded but could not be remembered has spent it all the same.
       */
      const spent = () => { setCode(""); setFromLink(false); onConsumed(); };
      void pairBrowser(code, name, remember)
        .then(() => { spent(); onSuccess(); })
        .catch((e: Error) => { if (browserConnection().identity) spent(); setError(e.message); })
        .finally(() => setBusy(false));
    }}>
      {linked ? <>
        <div className="pair-browser__form-heading"><span className="pair-browser__qr-mark"><SetupIcon name="qr" size={32} /></span><h2 ref={linkHeading} tabIndex={-1}>Connect this browser?</h2></div>
        <p role="alert">A link is asking to connect this browser to a Shahi computer. Only continue if you opened this link yourself, from a computer you control.</p>
        {linked.error ? <p className="login__error">{linked.error}</p> : <dl className="pair-browser__target">
          <dt>Relay</dt><dd><code>{linked.host}</code></dd>
          <dt>Computer identity</dt><dd><code>{linked.identity}</code></dd>
        </dl>}
      </> : <>
        <div className="pair-browser__form-heading"><span className="pair-browser__qr-mark"><SetupIcon name="qr" size={32} /></span><h2>Connect this browser</h2></div>
        <p>Use the QR code or pairing code shown on your computer.</p>
        <button className="pair-browser__scan" type="button" disabled={busy} onClick={() => { setScanning(true); setError(""); }}><SetupIcon name="qr" size={26} /><span>Scan QR code</span></button>
        <label htmlFor="pairing-code">Pairing code</label><textarea id="pairing-code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="shahi://pair#…" disabled={busy} />
      </>}
      <label htmlFor="browser-name">Device name</label><input id="browser-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoComplete="off" disabled={busy} />
      <label className="pair-browser__remember"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} disabled={busy} />Remember this browser</label>
      <p className="pair-browser__note">{remember ? "Stay connected next time you open Shahi. Use this only on your own device: anyone using this browser can access your computer." : "You’ll need a new code if you close or refresh this page. Each code works once."}</p>
      {error && <p role="alert" className="login__error">{error}</p>}
      {linked
        ? <>
          {!linked.error && <button type="submit" className="pair-browser__connect" disabled={busy}>{`Connect to ${linked.host}`}</button>}
          <button type="button" onClick={dismissLink} disabled={busy}>Cancel</button>
        </>
        : <button type="submit" className="pair-browser__connect" disabled={busy || !code.trim()}>{busy ? "Connecting securely…" : "Connect"}</button>}
      {error && browserConnection().identity && <button type="button" onClick={onSuccess}>Continue for this session</button>}
      <p className="pair-browser__note">Connecting lets this browser control your work on the computer. You can remove its access in Settings from any connected device.</p>
    </form>
    {scanning && <QrScanner onCode={(value) => { setCode(value); setScanning(false); }} onClose={() => setScanning(false)} onError={(value) => { setError(value); setScanning(false); }} />}
  </main>;
}
function QrScanner({ onCode, onClose, onError }: { onCode(value: string): void; onClose(): void; onError(value: string): void }) {
  const dialog = useDialog(onClose);
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
  return <div ref={dialog} tabIndex={-1} className="viewer" role="dialog" aria-modal="true" aria-label="Scan pairing QR code"><header className="viewer__bar"><h2>Scan pairing QR code</h2><button onClick={onClose}>Cancel</button></header><video className="pair-browser__camera" ref={video} playsInline muted /><p>Point your camera at the QR code shown by Shahi in herdr.</p></div>;
}

function SetupCommand({ command, label }: { command: string; label: string }) {
  const [status, setStatus] = useState("");
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(""), 4000);
    return () => clearTimeout(timer);
  }, [status]);
  return <div className="setup-command">
    <div className="setup-command__line"><code>{command}</code><button type="button" aria-label={label} title={label} onClick={async () => {
      try { await navigator.clipboard.writeText(command); setStatus("Copied"); }
      catch { setStatus("Select the command to copy it."); }
    }}><UiIcon name={status === "Copied" ? "check" : "copy"} /></button></div>
    <span role="status" className="setup-command__status">{status}</span>
  </div>;
}
