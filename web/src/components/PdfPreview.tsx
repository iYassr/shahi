import { useEffect, useRef, useState } from "react";
import { useApi } from "../api";
import { FileDownloadError } from "@shahi/shared/file-download";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
GlobalWorkerOptions.workerSrc = workerUrl;

/** Renders PDF pages without executing embedded scripts or external actions. */
export default function PdfPreview({ url }: { url: string }) {
  const api = useApi();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy>();
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true; let task: ReturnType<typeof getDocument> | undefined;
    setDocument(undefined); setPage(1); setError("");
    void api.fileBytesAt(url).then(async value => {
      if (!live) return;
      task = getDocument({ data: value, useSystemFonts: true });
      const pdf = await task.promise;
      if (live) setDocument(pdf);
    }).catch((e: unknown) => {
      // The computer's reason when it gave one (over 25 MB, an out-of-date
      // computer, a file that moved); otherwise the bytes did not parse.
      if (live) setError(e instanceof FileDownloadError ? e.message : "This PDF cannot be previewed. Download it to open in another app.");
    });
    return () => { live = false; void task?.destroy(); };
  }, [api, url]);
  useEffect(() => {
    if (!document || !canvas.current) return;
    let live = true; let render: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | undefined;
    void document.getPage(page).then(async pdfPage => {
      if (!live || !canvas.current) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const width = Math.max(240, canvas.current.parentElement?.clientWidth ?? 640);
      const scale = Math.min(width / base.width, 2) * zoom;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = pdfPage.getViewport({ scale: scale * ratio });
      canvas.current.width = viewport.width; canvas.current.height = viewport.height;
      canvas.current.style.width = `${viewport.width / ratio}px`; canvas.current.style.height = `${viewport.height / ratio}px`;
      render = pdfPage.render({ canvas: canvas.current, viewport }); await render.promise;
    }).catch(e => { if (live && e?.name !== "RenderingCancelledException") setError("This page could not be displayed. You can still download the PDF."); });
    return () => { live = false; render?.cancel(); };
  }, [document, page, zoom]);
  if (error) return <p role="alert">{error}</p>;
  if (!document) return <p role="status">Opening PDF…</p>;
  return <section className="pdf-preview" aria-label="PDF preview">
    <nav aria-label="PDF pages">
      <button disabled={page === 1} onClick={() => setPage(p => p - 1)}>Previous</button>
      <span aria-live="polite">Page {page} of {document.numPages}</span>
      <button disabled={page === document.numPages} onClick={() => setPage(p => p + 1)}>Next</button>
      <button aria-label="Zoom out" disabled={zoom <= 0.75} onClick={() => setZoom(z => z - 0.25)}>−</button>
      <button aria-label="Zoom in" disabled={zoom >= 2} onClick={() => setZoom(z => z + 0.25)}>+</button>
    </nav>
    <div className="pdf-preview__page"><canvas key={`${page}-${zoom}`} ref={canvas} role="img" aria-label={`PDF page ${page}. Download the file for selectable text and full accessibility.`} /></div>
  </section>;
}
