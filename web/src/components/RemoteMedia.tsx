import { useEffect, useState, type ImgHTMLAttributes } from "react";
import { api } from "../api";
import { releaseBlob } from "../connection";

export function RemoteImage({ src, ...props }: ImgHTMLAttributes<HTMLImageElement> & { src: string }) {
  const [blob, setBlob] = useState<string>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let owned: string | undefined;
    setBlob(undefined); setError("");
    void api.mediaAt(src).then((url) => { owned = url; if (active) setBlob(url); else releaseBlob(url); }).catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; if (owned) releaseBlob(owned); };
  }, [src]);
  return error ? <span role="alert">{error}</span> : blob ? <img {...props} src={blob} /> : <span aria-label="Loading image">Loading image…</span>;
}
export function Download({ path, name, className, children }: { path: string; name: string; className?: string; children: React.ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <><button className={className} aria-label={`Download ${name}`} disabled={busy} onClick={() => {
    setBusy(true); setError("");
    void api.mediaAt(path, true).then((url) => {
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.rel = "noopener"; anchor.click();
      // Let Safari consume the Blob before releasing it; sign-out releases it immediately.
      setTimeout(() => releaseBlob(url), 30_000);
    }).catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  }}>{busy ? "Downloading…" : children}</button>{error && <span role="alert">{error}</span>}</>;
}
